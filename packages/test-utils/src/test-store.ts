import { DbspEngine } from '@syncengine/dbsp';
import {
    type AnyTable,
    type ViewBuilder,
    type AnyEntity,
    type EmitInsert,
    extractMergeConfig,
    applyHandler as coreApplyHandler,
    extractEmits,
} from '@syncengine/core';

// ── Types ────────────────────────────────────────────────────────────────

export interface TestStoreConfig {
    tables: readonly AnyTable[];
    views: Record<string, ViewBuilder<unknown>>;
}

export interface HandlerResult {
    state: Record<string, unknown>;
    emits: EmitInsert[];
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

    /** Delete a row by PK. Throws if not found. */
    delete<T extends AnyTable>(table: T, id: number | string): void {
        const tableName = table.$name;
        const tableRows = this.rowStore.get(tableName);
        const existing = tableRows?.get(id);
        if (!existing) {
            throw new Error(`TestStore.delete: no row with id=${id} in table '${tableName}'`);
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

    /** Run an entity handler. Returns new state + emits. Does NOT insert emits. */
    applyHandler(
        entity: AnyEntity,
        handlerName: string,
        state: Record<string, unknown> | null,
        args: readonly unknown[],
    ): HandlerResult {
        const nextState = coreApplyHandler(entity, handlerName, state, args);
        const emits = extractEmits(nextState) ?? [];
        return { state: nextState, emits };
    }

    /** Insert emits into the pipeline. Resolves '$key' placeholders. */
    applyEmits(emits: readonly EmitInsert[], entityKey?: string): void {
        for (const emitItem of emits) {
            const tableName = resolveTableName(emitItem);
            const tableRef = this.tableMap.get(tableName);
            if (!tableRef) {
                throw new Error(`TestStore.applyEmits: unknown table '${tableName}'`);
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
