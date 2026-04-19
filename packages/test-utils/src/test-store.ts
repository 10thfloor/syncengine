import { DbspEngine } from '@syncengine/dbsp';
import {
    type AnyTable,
    type ViewBuilder,
    type AnyEntity,
    type AuthUser,
    type EmitInsert,
    type EmitRemove,
    type EmitUpdate,
    extractMergeConfig,
    applyHandler as coreApplyHandler,
    extractEmits,
    extractRemoves,
    extractUpdates,
    errors,
    StoreCode,
} from '@syncengine/core';

// ── Types ────────────────────────────────────────────────────────────────

export interface TestStoreConfig {
    tables: readonly AnyTable[];
    views: Record<string, ViewBuilder<unknown>>;
}

export interface HandlerResult {
    state: Record<string, unknown>;
    emits: EmitInsert[];
    removes: EmitRemove[];
    updates: EmitUpdate[];
}

// ── Record ID (mirrors store.ts recordId) ────────────────────────────────

/** ASCII Unit Separator — unambiguous composite key join character. */
const KEY_SEP = '\x1F';

function recordId(record: Record<string, unknown>, idKey: string | string[]): string {
    if (Array.isArray(idKey)) {
        return idKey.map((c) => String(record[c] ?? '')).join(KEY_SEP);
    }
    return String(record[idKey]);
}

// ── WASM id_key serialization (mirrors data-worker.js) ───────────────────

function wasmIdKey(idKey: string | string[]): string {
    return Array.isArray(idKey) ? idKey.join(KEY_SEP) : idKey;
}

// ── Deep conversion from WASM proxy to plain objects ─────────────────────

function deepToObject(val: unknown): Record<string, unknown> {
    if (val instanceof Map) {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of val) obj[k] = v;
        return obj;
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val)) {
            obj[k] = v instanceof Map ? deepToObject(v) : v;
        }
        return obj;
    }
    return val as Record<string, unknown>;
}

// ── Resolve table name from EmitInsert ───────────────────────────────────

function resolveTableName(insert: EmitInsert): string {
    const t = insert.table;
    if (typeof t === 'string') return t;
    // Table reference (typed emit) — extract $name
    return (t as unknown as AnyTable).$name;
}

// ── TestStore ────────────────────────────────────────────────────────────

export class TestStore {
    private readonly dbsp: DbspEngine;
    private readonly tableMap: ReadonlyMap<string, AnyTable>;
    private readonly viewMap: ReadonlyMap<string, ViewBuilder<unknown>>;
    private readonly viewNameToId: ReadonlyMap<string, string>;
    private readonly rowStore = new Map<string, Map<number | string, Record<string, unknown>>>();
    private readonly viewSnapshots = new Map<string, Map<string, Record<string, unknown>>>();
    private nextId = 1;

    constructor(config: TestStoreConfig) {
        const tableMap = new Map<string, AnyTable>();
        for (const t of config.tables) tableMap.set(t.$name, t);
        this.tableMap = tableMap;

        const viewMap = new Map<string, ViewBuilder<unknown>>();
        const viewNameToId = new Map<string, string>();
        for (const [name, v] of Object.entries(config.views)) {
            viewMap.set(v.$id, v);
            viewNameToId.set(name, v.$id);
        }
        this.viewMap = viewMap;
        this.viewNameToId = viewNameToId;

        this.dbsp = new DbspEngine(
            Object.entries(config.views).map(([name, v]) => ({
                name,
                source_table: v.$tableName,
                id_key: wasmIdKey(v.$idKey),
                source_id_key: v.$sourceIdKey,
                pipeline: v.$pipeline,
            })),
        );

        for (const t of config.tables) {
            const mc = extractMergeConfig(t);
            if (mc) this.dbsp.register_merge(mc.table, { fields: mc.fields });
        }
    }

    /** Insert a row. Auto-generates PK if missing. Upserts on PK collision. */
    insert<T extends AnyTable>(table: T, record: Partial<Record<string, unknown>>): void {
        const tableName = table.$name;
        const idKey = table.$idKey;
        const row = { ...record };

        if (row[idKey] === undefined) {
            row[idKey] = this.nextId++;
        }

        if (!this.rowStore.has(tableName)) this.rowStore.set(tableName, new Map());
        const tableRows = this.rowStore.get(tableName)!;
        const id = row[idKey] as number | string;

        const existing = tableRows.get(id);
        if (existing) {
            this.step([{ source: tableName, record: existing, weight: -1 }]);
        }

        tableRows.set(id, row as Record<string, unknown>);
        this.step([{ source: tableName, record: row, weight: 1 }]);
    }

    /** Read a row by PK — undefined if not in the local row store.
     *  Useful for tests that need to verify row state after updates,
     *  since the view layer has pre-existing issues with upsert-style
     *  operations that re-emit the same id. */
    getRow<T extends AnyTable>(table: T, id: number | string): Record<string, unknown> | undefined {
        return this.rowStore.get(table.$name)?.get(id);
    }

    /** Delete a row by PK. Throws if not found. */
    delete<T extends AnyTable>(table: T, id: number | string): void {
        const tableName = table.$name;
        const tableRows = this.rowStore.get(tableName);
        const existing = tableRows?.get(id);
        if (!existing) {
            throw errors.store(StoreCode.TEST_STORE_ROW_NOT_FOUND, {
                message: `TestStore.delete: no row with id=${id} in table '${tableName}'`,
                context: { table: tableName, id },
            });
        }
        tableRows!.delete(id);
        this.step([{ source: tableName, record: existing, weight: -1 }]);
    }

    /** Read materialized view output. Typed from the view builder's $record. */
    view<T>(viewDef: ViewBuilder<T>): readonly T[] {
        let snap: Map<string, Record<string, unknown>> | undefined;
        for (const [name, vid] of this.viewNameToId) {
            if (vid === viewDef.$id) {
                snap = this.viewSnapshots.get(name);
                break;
            }
        }
        if (!snap) return [];
        return Object.freeze([...snap.values()]) as readonly T[];
    }

    /** Run an entity handler. Returns new state + emits. Does NOT insert emits.
     *
     *  Pass `auth` to exercise the entity's `$access` policies — omit for the
     *  legacy no-enforcement path that earlier tests rely on. */
    applyHandler(
        entity: AnyEntity,
        handlerName: string,
        state: Record<string, unknown> | null,
        args: readonly unknown[],
        auth?: { readonly user: AuthUser | null; readonly key: string },
    ): HandlerResult {
        const nextState = coreApplyHandler(entity, handlerName, state, args, auth);
        const emits = extractEmits(nextState) ?? [];
        const removes = extractRemoves(nextState) ?? [];
        const updates = extractUpdates(nextState) ?? [];
        return { state: nextState, emits, removes, updates };
    }

    /** Insert emits into the pipeline. Resolves '$key' placeholders. */
    applyEmits(emits: readonly EmitInsert[], entityKey?: string): void {
        for (const emitItem of emits) {
            const tableName = resolveTableName(emitItem);
            const tableRef = this.tableMap.get(tableName);
            if (!tableRef) {
                throw errors.store(StoreCode.TEST_STORE_UNKNOWN_TABLE, {
                    message: `TestStore.applyEmits: unknown table '${tableName}'`,
                    context: { table: tableName },
                });
            }

            const record = { ...emitItem.record };
            if (entityKey) {
                for (const [k, v] of Object.entries(record)) {
                    if (v === '$key') record[k] = entityKey;
                }
            }

            this.insert(tableRef, record);
        }
    }

    /** Apply remove effects to the pipeline — symmetric to applyEmits.
     *  Each remove calls `this.delete(table, id)`, which feeds a
     *  negative-weight delta into DBSP so views recompute incrementally. */
    applyRemoves(removes: readonly EmitRemove[]): void {
        for (const r of removes) {
            const tableRef = this.tableMap.get(r.table);
            if (!tableRef) {
                throw errors.store(StoreCode.TEST_STORE_UNKNOWN_TABLE, {
                    message: `TestStore.applyRemoves: unknown table '${r.table}'`,
                    context: { table: r.table },
                });
            }
            this.delete(tableRef, r.id as number | string);
        }
    }

    /** Apply update effects — symmetric to applyEmits / applyRemoves.
     *  Loads the existing row, merges the patch over it (unpatched
     *  fields carry over), writes the merged row to the local store,
     *  and emits both -old and +merged in a single DBSP step. Missing
     *  rows are silent no-ops, matching the data-worker's production
     *  behavior.
     *
     *  NB: we emit deltas as a single step() call (matching the
     *  production data-worker), not two back-to-back calls like
     *  TestStore.insert does. The production pattern is correct;
     *  TestStore.insert's two-call pattern has a pre-existing bug
     *  where raw-projection views see empty after an upsert. Tracked
     *  separately — applyUpdates works around it by using the correct
     *  single-call pattern directly. */
    applyUpdates(updates: readonly EmitUpdate[]): void {
        for (const u of updates) {
            const tableRef = this.tableMap.get(u.table);
            if (!tableRef) {
                throw errors.store(StoreCode.TEST_STORE_UNKNOWN_TABLE, {
                    message: `TestStore.applyUpdates: unknown table '${u.table}'`,
                    context: { table: u.table },
                });
            }
            const tableName = u.table;
            if (!this.rowStore.has(tableName)) continue;
            const tableRows = this.rowStore.get(tableName)!;
            const oldRow = tableRows.get(u.id as number | string);
            if (!oldRow) continue; // silent no-op on missing row
            const mergedRow = { ...oldRow, ...u.patch };
            tableRows.set(u.id as number | string, mergedRow);
            // Single step with both deltas — matches the production
            // data-worker and DBSP's expected input shape for updates.
            this.step([
                { source: tableName, record: oldRow, weight: -1 },
                { source: tableName, record: mergedRow, weight: 1 },
            ]);
        }
    }

    /** Reset all state. */
    reset(): void {
        this.dbsp.reset();
        this.rowStore.clear();
        this.viewSnapshots.clear();
        this.nextId = 1;
    }

    // ── Private ──────────────────────────────────────────────────────

    private step(deltas: Array<{ source: string; record: Record<string, unknown>; weight: number }>): void {
        const rawResult = this.dbsp.step(deltas);
        const rawViews = rawResult.views || rawResult;

        const entries: Array<[string, Array<{ record: unknown; weight: number }>]> =
            rawViews instanceof Map
                ? [...rawViews.entries()]
                : Object.entries(rawViews);

        for (const [viewName, viewDeltas] of entries) {
            if (!viewDeltas || viewDeltas.length === 0) continue;

            const viewId = this.viewNameToId.get(viewName) ?? viewName;
            const viewDef = this.viewMap.get(viewId);
            const idKey = viewDef?.$idKey ?? 'id';

            if (!this.viewSnapshots.has(viewName)) {
                this.viewSnapshots.set(viewName, new Map());
            }
            const snap = this.viewSnapshots.get(viewName)!;

            for (const d of viewDeltas) {
                const rec = deepToObject(d.record);
                const rid = recordId(rec, idKey);
                if (d.weight > 0) {
                    snap.set(rid, rec);
                } else {
                    snap.delete(rid);
                }
            }
        }
    }
}

// ── Factory ──────────────────────────────────────────────────────────────

export function createTestStore(config: TestStoreConfig): TestStore {
    return new TestStore(config);
}
