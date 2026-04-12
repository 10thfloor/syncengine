/// <reference path="./runtime-config.d.ts" />

// ── Store ───────────────────────────────────────────────────────────────────
//
// The Phase 2.5 store surface is:
//
//     const db = store({ tables, views, channels?, seed?, ... });
//
//     db.use({ myView, otherView })   // consolidated React hook
//     db.tables.expenses.insert({...}) // typed imperative
//     db.tables.expenses.remove(id)
//     db.tables.expenses.seed({...})
//     db.channels.team               // typed channel handle (if channels declared)
//     db.destroy()                   // teardown
//
// Everything else — connection status, sync phase, conflict log, undo —
// comes through the return of `db.use({...})`:
//
//     const { views, ready, connection, sync, conflicts, undo, actions } = db.use({ topExpenses });
//     views.topExpenses[0].amount       // typed, no cast
//     undo.run()                        // undo last mutation
//     actions.reset()                   // wipe local + publish RESET
//     actions.dismissConflict(index)    // mark a conflict as handled

import { useSyncExternalStore, useCallback, useEffect, useMemo, useRef } from 'react';
import {
    extractMergeConfig,
    tableToCreateSQL,
    tableToInsertSQL,
    CONFLICT_LOG_MAX,
    type AnyTable,
    type Table,
    type ColumnDef,
    type ViewBuilder,
    type ChannelConfig,
    type ChannelNames,
    type InferRecord,
    type Migration,
    type ConnectionStatus,
    type SyncStatus,
    type ConflictRecord,
    type TopicDef,
    type EntityStateShape,
    type EntityState,
} from '@syncengine/core';
import type { SyncConfig } from '@syncengine/core/internal';
// Runtime-config virtual module — populated at bundle time by
// @syncengine/vite-plugin from .syncengine/dev/runtime.json (dev) or
// SYNCENGINE_* env vars (prod). User code never touches these values.
import {
    workspaceId as runtimeWorkspaceId,
    natsUrl as runtimeNatsUrl,
    restateUrl as runtimeRestateUrl,
    authToken as runtimeAuthToken,
    // eslint-disable-next-line import/no-unresolved
} from 'virtual:syncengine/runtime-config';

// Re-export connection/status types for React components
export type { ConnectionStatus, SyncStatus, ConflictRecord };

// ── Worker message types (internal, unchanged from the pre-2.5 protocol) ─

interface InitMessage {
    type: 'INIT';
    schema: {
        tables: Array<{ name: string; sql: string; insertSql: string; columns: string[] }>;
        views: Array<{
            name: string;
            tableName: string;
            source_table: string;
            id_key: string;
            /** Source table's primary key — independent of `id_key`, which
             *  may be rewritten by an `aggregate` op. The DBSP join uses
             *  this for `left_index` dedup so a downstream aggregate doesn't
             *  collapse all source rows in a group to a single entry. */
            source_id_key: string;
            pipeline: unknown[];
            sourceTables: string[];
            monotonicity: string;
        }>;
        mergeConfigs: Array<{ table: string; fields: Record<string, string> }>;
    };
    sync: SyncConfig;
    schemaVersion?: number;
    migrations?: Migration[];
}

interface InsertMessage { type: 'INSERT'; table: string; record: Record<string, unknown>; _noUndo?: boolean; _localOnly?: boolean }
interface DeleteMessage { type: 'DELETE'; table: string; id: unknown }
interface ResetMessage { type: 'RESET' }
interface UndoMessage { type: 'UNDO' }
interface TopicSubscribeMessage { type: 'TOPIC_SUBSCRIBE'; name: string; key: string }
interface TopicPublishMessage { type: 'TOPIC_PUBLISH'; name: string; key: string; data: Record<string, unknown> }
interface TopicLeaveMessage { type: 'TOPIC_LEAVE'; name: string; key: string }
interface TopicUnsubscribeMessage { type: 'TOPIC_UNSUBSCRIBE'; name: string; key: string }

type WorkerOutMessage =
    | { type: 'WORKER_LOADED' }
    | { type: 'READY' }
    | { type: 'VIEW_UPDATE'; viewName: string; deltas: Array<{ record: Record<string, unknown>; weight: number }> }
    | { type: 'FULL_SYNC'; snapshots: Record<string, Record<string, unknown>[]> }
    | { type: 'UNDO_SIZE'; size: number }
    | { type: 'CONNECTION_STATUS'; status: ConnectionStatus }
    | { type: 'SYNC_STATUS'; phase: 'idle' | 'replaying' | 'live'; messagesReplayed: number; totalMessages?: number; snapshotLoaded?: boolean }
    | { type: 'MIGRATION_STATUS'; fromVersion: number; toVersion: number; status: 'running' | 'complete' | 'failed'; stepsApplied: number; error?: string; failedAtVersion?: number }
    | { type: 'CONFLICTS'; conflicts: Array<{ table: string; recordId: string; field: string; winner: unknown; loser: unknown; winnerHlc: number; loserHlc: number; strategy: string }> }
    | { type: 'TOPIC_UPDATE'; name: string; key: string; peerId: string; data: Record<string, unknown>; ts: number; leave: boolean };

type WorkerInMessage = InitMessage | InsertMessage | DeleteMessage | ResetMessage | UndoMessage
    | TopicSubscribeMessage | TopicPublishMessage | TopicLeaveMessage | TopicUnsubscribeMessage;

// ── User-facing config types ─────────────────────────────────────────────

/**
 * Seed map: keyed by table name, value is an array of records shaped like
 * the table's `InferRecord`. The `$idKey` column can be omitted — the
 * store synthesizes IDs via HLC tick at seed time.
 */
export type SeedMap<TTables extends readonly AnyTable[]> = {
    readonly [T in TTables[number] as T['$name']]?: ReadonlyArray<
        Partial<Pick<T['$record'], T['$idKey']>> & Omit<T['$record'], T['$idKey']>
    >;
};

/**
 * Config passed to `store(...)`. The `tables`, `views`, and (optional)
 * `channels` arrays drive the entire downstream typed surface —
 * `db.tables`, `db.use(...)`, seed keys, channel names, etc.
 */
export interface StoreConfig<
    TTables extends readonly AnyTable[] = readonly AnyTable[],
    TChannels extends readonly ChannelConfig[] = readonly ChannelConfig[],
> {
    readonly tables: TTables;
    readonly views: readonly ViewBuilder<unknown>[];
    readonly channels?: TChannels;
    readonly seed?: SeedMap<TTables>;
    readonly schemaVersion?: number;
    readonly migrations?: readonly Migration[];
}

/** Per-table typed imperative namespace — one entry per table in the config. */
type TableNamespace<TTables extends readonly AnyTable[]> = {
    readonly [T in TTables[number] as T['$name']]: {
        /**
         * Insert a record. The primary-key column (`id()` by convention)
         * is optional — the store synthesizes an ID via HLC tick if
         * omitted.
         */
        insert(
            record: Partial<Pick<T['$record'], T['$idKey']>> & Omit<T['$record'], T['$idKey']>,
        ): void;
        /** Delete by primary key. */
        remove(id: T['$record'][T['$idKey']]): void;
        /**
         * Insert without undo tracking and without publishing to NATS.
         * Used by the seed lifecycle and for local-only fixture data.
         */
        seed(
            record: Partial<Pick<T['$record'], T['$idKey']>> & Omit<T['$record'], T['$idKey']>,
        ): void;
    };
};

/** Per-channel metadata exposed on `db.channels`. */
interface ChannelHandle<W extends string, C extends string> {
    readonly name: C;
    readonly subject: `ws.${W}.ch.${C}.deltas`;
    readonly tables: readonly AnyTable[];
}

type ChannelNamespace<TChannels extends readonly ChannelConfig[]> = {
    readonly [C in ChannelNames<TChannels>]: ChannelHandle<string, C>;
};

/** Value returned from `db.use({...})`. The `views` shape is driven by the
 *  caller's argument: each key maps to the view's record array. */
export interface UseResult<TViews extends Record<string, ViewBuilder<unknown>>> {
    readonly views: { [K in keyof TViews]: ReadonlyArray<
        TViews[K] extends ViewBuilder<infer R> ? R : never
    > };
    readonly ready: boolean;
    readonly connection: ConnectionStatus;
    readonly sync: SyncStatus;
    readonly conflicts: readonly ConflictRecord[];
    readonly undo: { readonly size: number; run: () => void };
    readonly actions: {
        reset: () => void;
        dismissConflict: (index: number) => void;
    };
}

/** Result of `db.useTopic(topicDef, key)`. */
export interface UseTopicResult<TState> {
    /** Map of every other peer's latest published state, keyed by peer ID. */
    readonly peers: ReadonlyMap<string, TState & { readonly $ts: number }>;
    /** Publish this peer's state to all subscribers. Internally throttled to 20fps. */
    publish(data: TState): void;
    /** Signal departure and unsubscribe. Called automatically on unmount. */
    leave(): void;
}

/** The returned `Store<T>` — top-level surface is `{ use, useTopic, tables, channels, destroy }`. */
export interface Store<
    TTables extends readonly AnyTable[] = readonly AnyTable[],
    TChannels extends readonly ChannelConfig[] = readonly ChannelConfig[],
> {
    /** Consolidated React hook. Select views by name; returns typed data
     *  and the full sync/status/conflict bundle. */
    use<TViews extends Record<string, ViewBuilder<unknown>>>(views: TViews): UseResult<TViews>;

    /** Subscribe to an ephemeral topic. Returns a reactive peer map and
     *  a publish function for broadcasting this peer's state. */
    useTopic<TName extends string, TShape extends EntityStateShape>(
        topicDef: TopicDef<TName, TShape>,
        key: string,
        opts?: { ttl?: number },
    ): UseTopicResult<EntityState<TShape>>;

    /** Per-table typed imperative namespace. */
    readonly tables: TableNamespace<TTables>;

    /** Per-channel typed metadata. Empty object when `channels` isn't declared. */
    readonly channels: ChannelNamespace<TChannels>;

    /** Terminate the worker and clear subscriptions. */
    destroy(): void;
}

// ── Fail-fast validation ─────────────────────────────────────────────────

export function validateStoreConfig(config: StoreConfig): void {
    // 1. Every table must have a primary key.
    for (const t of config.tables) {
        const hasPk = Object.values(t.$columns).some((c) => (c as ColumnDef<unknown>).primaryKey);
        if (!hasPk) {
            throw new Error(
                `Table '${t.$name}' has no primary key column — use id() for an ` +
                `auto-generated integer PK.`,
            );
        }
    }

    // 2. No duplicate table names.
    const tableNames = new Set<string>();
    for (const t of config.tables) {
        if (tableNames.has(t.$name)) {
            throw new Error(`Duplicate table name: '${t.$name}'.`);
        }
        tableNames.add(t.$name);
    }

    // 3. No duplicate view ids (internal catch; view ids are auto-generated
    //    so this should only fire on programmer error).
    const viewIds = new Set<string>();
    for (const v of config.views) {
        if (viewIds.has(v.$id)) {
            throw new Error(`Duplicate view id: '${v.$id}' (internal bug, please report).`);
        }
        viewIds.add(v.$id);
    }

    // 4. Every view must reference a known table (via its primary table and
    //    any tables joined in the pipeline).
    for (const v of config.views) {
        for (const tableName of v.$sourceTables) {
            if (!tableNames.has(tableName)) {
                throw new Error(
                    `View '${v.$id}' references unknown table '${tableName}'. ` +
                    `Add the table to config.tables, or remove the reference.`,
                );
            }
        }
    }

    // 5. Every channel table must be one of the config.tables.
    if (config.channels) {
        const channelNames = new Set<string>();
        for (const ch of config.channels) {
            if (channelNames.has(ch.name)) {
                throw new Error(`Duplicate channel name: '${ch.name}'.`);
            }
            channelNames.add(ch.name);

            for (const t of ch.tables) {
                if (!tableNames.has(t.$name)) {
                    throw new Error(
                        `Channel '${ch.name}' references unknown table '${t.$name}'. ` +
                        `Add the table to config.tables, or remove it from the channel.`,
                    );
                }
            }
        }

        // 6. Every table must be covered by some channel (only when channels set).
        const coveredTables = new Set<string>();
        for (const ch of config.channels) {
            for (const t of ch.tables) coveredTables.add(t.$name);
        }
        for (const t of config.tables) {
            if (!coveredTables.has(t.$name)) {
                throw new Error(
                    `Table '${t.$name}' is not mapped to any channel. Either add it ` +
                    `to a channel or remove the channels field entirely.`,
                );
            }
        }
    }

    // 7. Every seed key must match a real table name.
    if (config.seed) {
        for (const seedKey of Object.keys(config.seed)) {
            if (!tableNames.has(seedKey)) {
                throw new Error(
                    `seed key '${seedKey}' does not correspond to any table in config.tables.`,
                );
            }
        }
    }
}

// ── store() ───────────────────────────────────────────────────────────────

let nextSynthId = 1;
function synthesizeId(): number {
    // HLC-ish monotonic ID: combine Date.now() with a counter so concurrent
    // inserts within the same ms get distinct ids. Good enough for local-first.
    return Date.now() * 1000 + (nextSynthId++ % 1000);
}

export function store<
    const TTables extends readonly AnyTable[],
    const TChannels extends readonly ChannelConfig[] = readonly [],
>(
    config: StoreConfig<TTables, TChannels>,
): Store<TTables, TChannels> {
    validateStoreConfig(config);

    // Build the internal SyncConfig from the runtime virtual module. User
    // code no longer supplies NATS URLs or workspace IDs — the framework
    // threads them through via `virtual:syncengine/runtime-config`.
    const syncConfig: SyncConfig = {
        workspaceId: runtimeWorkspaceId,
        natsUrl: runtimeNatsUrl,
        restateUrl: runtimeRestateUrl,
        ...(runtimeAuthToken ? { authToken: runtimeAuthToken } : {}),
        ...(config.channels ? { channels: [...config.channels] } : {}),
    };

    // Map each config view's $id → a stable display name the worker uses
    // for VIEW_UPDATE messages. We pre-assign them from $id directly since
    // those are already unique per view() call.
    const viewsById = new Map<string, ViewBuilder<unknown>>();
    for (const v of config.views) viewsById.set(v.$id, v);

    const schemaPayload: InitMessage['schema'] = {
        tables: config.tables.map((t) => ({
            name: t.$name,
            sql: tableToCreateSQL(t),
            insertSql: tableToInsertSQL(t),
            columns: Object.keys(t.$columns),
        })),
        views: config.views.map((v) => ({
            name: v.$id,
            tableName: v.$tableName,
            source_table: v.$tableName,
            id_key: v.$idKey,
            source_id_key: v.$sourceIdKey,
            pipeline: v.$pipeline,
            sourceTables: v.$sourceTables,
            monotonicity: v.$monotonicity,
        })),
        mergeConfigs: config.tables
            .map((t) => extractMergeConfig(t))
            .filter((c): c is NonNullable<typeof c> => c !== null),
    };

    let worker: Worker | null = null;
    let ready = false;
    const readyListeners = new Set<() => void>();

    // ── Per-view state (keyed by $id) ───────────────────────────────────
    const viewSnapshots = new Map<string, unknown[]>();
    const viewSubscribers = new Map<string, Set<() => void>>();
    const EMPTY: readonly unknown[] = Object.freeze([]);

    let undoSize = 0;
    const undoSubscribers = new Set<() => void>();

    // Always start in 'connecting' — the runtime config always resolves
    // to a NATS URL (dev default or env-supplied prod value).
    let connectionStatus: ConnectionStatus = 'connecting';
    const connectionSubscribers = new Set<() => void>();

    let syncStatus: SyncStatus = { phase: 'idle', messagesReplayed: 0, snapshotLoaded: false };
    const syncStatusSubscribers = new Set<() => void>();

    let conflictLog: ConflictRecord[] = [];
    const conflictSubscribers = new Set<() => void>();

    // ── Topic state (ephemeral pub/sub) ────────────────────────────────
    const topicPeers = new Map<string, Map<string, Record<string, unknown>>>();
    const topicSubscribers = new Map<string, Set<() => void>>();
    const topicRefCounts = new Map<string, number>();
    const topicTimers = new Map<string, ReturnType<typeof setInterval>>();
    const TOPIC_DEFAULT_TTL = 5000;
    const TOPIC_THROTTLE_MS = 50;

    // ── Seed lifecycle (Phase 2.5 item 6) ──────────────────────────────
    //
    // Whenever the store reaches a "clean" state — READY after initial
    // hydrate, or after an actions.reset() wipes SQLite — re-apply every
    // seed row via the _localOnly + _noUndo INSERT worker path.
    //
    // We gate on `seedsApplied` so the hot path (READY → replay → live) only
    // seeds once. The flag is cleared by RESET and by an empty FULL_SYNC,
    // which are the two code paths that wipe local state; the next READY or
    // phase=live transition will re-seed. For seed rows that omit the PK,
    // applying twice would duplicate rows (each call synthesizes a fresh id),
    // so this gate is load-bearing for correctness, not just efficiency.
    let seedsApplied = false;
    function applySeeds(): void {
        if (seedsApplied) return;
        if (!config.seed) {
            seedsApplied = true;
            return;
        }
        const seedEntries = Object.entries(config.seed) as Array<[
            string,
            ReadonlyArray<Record<string, unknown>> | undefined,
        ]>;
        for (const [tableName, rows] of seedEntries) {
            if (!rows) continue;
            const table = config.tables.find((t) => t.$name === tableName);
            const idKey = table?.$idKey;
            for (const row of rows) {
                const record = { ...row };
                // If the seed row omits the PK, synthesize one.
                if (idKey && record[idKey] === undefined) {
                    record[idKey] = synthesizeId();
                }
                send({
                    type: 'INSERT',
                    table: tableName,
                    record,
                    _noUndo: true,
                    _localOnly: true,
                });
            }
        }
        seedsApplied = true;
    }

    // ── View helpers ────────────────────────────────────────────────────
    function notifyView(viewId: string): void {
        viewSubscribers.get(viewId)?.forEach((fn) => fn());
    }

    function getSnapshot<T>(viewId: string): readonly T[] {
        return (viewSnapshots.get(viewId) ?? EMPTY) as readonly T[];
    }

    function applyDeltas(viewId: string, deltas: Array<{ record: Record<string, unknown>; weight: number }>): void {
        const view = viewsById.get(viewId);
        const idKey = view?.$idKey ?? 'id';
        const current = (viewSnapshots.get(viewId) ?? []) as Record<string, unknown>[];
        const next = [...current];

        for (const delta of deltas) {
            const recId = String(delta.record[idKey]);
            const idx = next.findIndex((item) => String(item[idKey]) === recId);
            if (idx !== -1) next.splice(idx, 1);
            if (delta.weight > 0) next.push(delta.record);
        }

        viewSnapshots.set(viewId, next);
        notifyView(viewId);
    }

    // ── Worker lifecycle ────────────────────────────────────────────────
    function getWorker(): Worker {
        if (worker) return worker;

        worker = new Worker(
            new URL('./workers/data-worker.js', import.meta.url),
            { type: 'module' },
        );

        worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
            const msg = event.data;

            if (msg.type === 'WORKER_LOADED') {
                const initMsg: InitMessage = {
                    type: 'INIT',
                    schema: schemaPayload,
                    sync: syncConfig,
                };
                if (config.schemaVersion) initMsg.schemaVersion = config.schemaVersion;
                if (config.migrations) initMsg.migrations = [...config.migrations];
                worker!.postMessage(initMsg);
                return;
            }

            switch (msg.type) {
                case 'READY':
                    ready = true;
                    readyListeners.forEach((fn) => fn());
                    readyListeners.clear();
                    applySeeds();
                    break;

                case 'VIEW_UPDATE':
                    applyDeltas(msg.viewName, msg.deltas);
                    break;

                case 'UNDO_SIZE':
                    undoSize = msg.size;
                    undoSubscribers.forEach((fn) => fn());
                    break;

                case 'CONNECTION_STATUS':
                    connectionStatus = msg.status;
                    connectionSubscribers.forEach((fn) => fn());
                    break;

                case 'SYNC_STATUS': {
                    const prevPhase = syncStatus.phase;
                    syncStatus = {
                        phase: msg.phase,
                        messagesReplayed: msg.messagesReplayed,
                        totalMessages: msg.totalMessages,
                        snapshotLoaded: msg.snapshotLoaded ?? syncStatus.snapshotLoaded,
                    };
                    syncStatusSubscribers.forEach((fn) => fn());
                    if (msg.phase === 'live') {
                        connectionStatus = 'connected';
                        connectionSubscribers.forEach((fn) => fn());
                        // Re-seed on entry to live (no-op if seeds already
                        // applied on the initial READY — handled by the
                        // seedsApplied gate inside applySeeds()).
                        if (prevPhase !== 'live') applySeeds();
                    }
                    break;
                }

                case 'FULL_SYNC':
                    for (const [viewId, records] of Object.entries(msg.snapshots)) {
                        viewSnapshots.set(viewId, records);
                        notifyView(viewId);
                    }
                    for (const viewId of viewSnapshots.keys()) {
                        if (!(viewId in msg.snapshots)) {
                            viewSnapshots.set(viewId, []);
                            notifyView(viewId);
                        }
                    }
                    if (Object.keys(msg.snapshots).length === 0) {
                        // Empty FULL_SYNC means the worker has wiped all
                        // snapshots — typically after RESET. Clear the
                        // conflict log and re-seed immediately, because the
                        // worker doesn't re-enter the replay→live cycle after
                        // a reset — phase=live won't fire again to trigger
                        // the gated re-seed from the SYNC_STATUS branch.
                        conflictLog = [];
                        conflictSubscribers.forEach((fn) => fn());
                        seedsApplied = false;
                        applySeeds();
                    }
                    break;

                case 'MIGRATION_STATUS':
                    // Schema migrations run on the worker; we don't currently
                    // expose progress through db.use(), but we track failure
                    // so a future UI surface can show it without another
                    // subscription. Logging is sufficient for research-phase.
                    if (msg.status === 'failed') {
                        // eslint-disable-next-line no-console
                        console.error(
                            `[syncengine] migration ${msg.fromVersion} → ${msg.toVersion} failed at v${msg.failedAtVersion}: ${msg.error}`,
                        );
                    }
                    break;

                case 'CONFLICTS': {
                    const now = Date.now();
                    for (const c of msg.conflicts) {
                        conflictLog.push({
                            table: c.table,
                            recordId: c.recordId,
                            field: c.field,
                            winner: { value: c.winner, hlc: c.winnerHlc },
                            loser: { value: c.loser, hlc: c.loserHlc },
                            strategy: c.strategy,
                            resolvedAt: now,
                            dismissed: false,
                        });
                    }
                    if (conflictLog.length > CONFLICT_LOG_MAX) {
                        conflictLog = conflictLog.slice(-CONFLICT_LOG_MAX);
                    }
                    conflictSubscribers.forEach((fn) => fn());
                    break;
                }

                case 'TOPIC_UPDATE': {
                    const subKey = `${msg.name}/${msg.key}`;
                    let peers = topicPeers.get(subKey);
                    if (!peers) { peers = new Map(); }
                    if (msg.leave) {
                        peers.delete(msg.peerId);
                    } else {
                        peers.set(msg.peerId, { ...msg.data, $ts: msg.ts });
                    }
                    // New Map reference for useSyncExternalStore identity check
                    topicPeers.set(subKey, new Map(peers));
                    topicSubscribers.get(subKey)?.forEach((fn) => fn());
                    break;
                }
            }
        };

        return worker;
    }

    // ── Internal dispatch ───────────────────────────────────────────────
    function send(msg: WorkerInMessage): void {
        getWorker().postMessage(msg);
    }

    // ── Table namespace (db.tables.{name}) ──────────────────────────────
    const tableNs = {} as Record<string, {
        insert(record: Record<string, unknown>): void;
        remove(id: unknown): void;
        seed(record: Record<string, unknown>): void;
    }>;

    for (const t of config.tables) {
        const tableName = t.$name;
        const idKey = t.$idKey;
        tableNs[tableName] = {
            insert(record: Record<string, unknown>): void {
                const filled = { ...record };
                if (filled[idKey] === undefined) filled[idKey] = synthesizeId();
                send({ type: 'INSERT', table: tableName, record: filled });
            },
            remove(id: unknown): void {
                send({ type: 'DELETE', table: tableName, id });
            },
            seed(record: Record<string, unknown>): void {
                const filled = { ...record };
                if (filled[idKey] === undefined) filled[idKey] = synthesizeId();
                send({
                    type: 'INSERT',
                    table: tableName,
                    record: filled,
                    _noUndo: true,
                    _localOnly: true,
                });
            },
        };
    }

    // ── Channel namespace (db.channels.{name}) ──────────────────────────
    const channelNs = {} as Record<string, ChannelHandle<string, string>>;
    if (config.channels) {
        for (const ch of config.channels) {
            channelNs[ch.name] = {
                name: ch.name,
                subject: `ws.${runtimeWorkspaceId}.ch.${ch.name}.deltas` as `ws.${string}.ch.${string}.deltas`,
                tables: ch.tables,
            };
        }
    }

    // ── Actions closures for db.use() ──────────────────────────────────
    function resetAction(): void {
        send({ type: 'RESET' });
        // The worker posts back FULL_SYNC and clears state; re-seeding
        // happens on the next SYNC_STATUS phase=live message.
    }

    function undoRun(): void {
        send({ type: 'UNDO' });
    }

    function dismissConflict(index: number): void {
        if (conflictLog[index]) {
            conflictLog = [...conflictLog];
            conflictLog[index] = { ...conflictLog[index], dismissed: true };
            conflictSubscribers.forEach((fn) => fn());
        }
    }

    // ── db.use({...}) — the consolidated React hook ─────────────────────
    function useHook<TViews extends Record<string, ViewBuilder<unknown>>>(
        views: TViews,
    ): UseResult<TViews> {
        // Stable keys across renders: memoize the selected view set on its
        // first frame. If the argument changes on a later render (e.g. the
        // caller passes a different view list), we re-subscribe.
        const viewsRef = useRef(views);
        if (!Object.is(views, viewsRef.current)) viewsRef.current = views;
        const activeViews = viewsRef.current;

        // Make sure the worker is booted.
        useEffect(() => {
            getWorker();
        }, []);

        // Per-view subscriptions
        const viewData: Record<string, readonly unknown[]> = {};
        for (const [key, viewBuilder] of Object.entries(activeViews)) {
            const viewId = viewBuilder.$id;
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const subscribe = useMemo(
                () => (onChange: () => void) => {
                    if (!viewSubscribers.has(viewId)) viewSubscribers.set(viewId, new Set());
                    viewSubscribers.get(viewId)!.add(onChange);
                    return () => { viewSubscribers.get(viewId)?.delete(onChange); };
                },
                [viewId],
            );
            // eslint-disable-next-line react-hooks/rules-of-hooks
            viewData[key] = useSyncExternalStore(subscribe, () => getSnapshot(viewId));
        }

        // Status subscriptions
        const subReady = useCallback((onChange: () => void) => {
            if (ready) { onChange(); return () => {}; }
            const listener = () => onChange();
            readyListeners.add(listener);
            return () => { readyListeners.delete(listener); };
        }, []);
        const isReady = useSyncExternalStore(subReady, () => ready);

        const subConn = useCallback((onChange: () => void) => {
            connectionSubscribers.add(onChange);
            return () => { connectionSubscribers.delete(onChange); };
        }, []);
        const connection = useSyncExternalStore(subConn, () => connectionStatus);

        const subSync = useCallback((onChange: () => void) => {
            syncStatusSubscribers.add(onChange);
            return () => { syncStatusSubscribers.delete(onChange); };
        }, []);
        const sync = useSyncExternalStore(subSync, () => syncStatus);

        const subConflicts = useCallback((onChange: () => void) => {
            conflictSubscribers.add(onChange);
            return () => { conflictSubscribers.delete(onChange); };
        }, []);
        const conflicts = useSyncExternalStore(subConflicts, () => conflictLog);

        const subUndo = useCallback((onChange: () => void) => {
            undoSubscribers.add(onChange);
            return () => { undoSubscribers.delete(onChange); };
        }, []);
        const undoCount = useSyncExternalStore(subUndo, () => undoSize);

        const undoObj = useMemo(
            () => ({ size: undoCount, run: undoRun }),
            [undoCount],
        );

        const actions = useMemo(
            () => ({ reset: resetAction, dismissConflict }),
            [],
        );

        return {
            views: viewData as UseResult<TViews>['views'],
            ready: isReady,
            connection,
            sync,
            conflicts,
            undo: undoObj,
            actions,
        };
    }

    // ── db.useTopic(topicDef, key) — ephemeral pub/sub hook ───────────
    function useTopicHook<TName extends string, TShape extends EntityStateShape>(
        topicDef: TopicDef<TName, TShape>,
        key: string,
        opts?: { ttl?: number },
    ): UseTopicResult<EntityState<TShape>> {
        const subKey = `${topicDef.$name}/${key}`;
        const ttl = opts?.ttl ?? TOPIC_DEFAULT_TTL;

        // Boot the worker on first use (same as useHook).
        useEffect(() => { getWorker(); }, []);

        // Manage subscription lifecycle with refcounting.
        useEffect(() => {
            const prev = topicRefCounts.get(subKey) ?? 0;
            topicRefCounts.set(subKey, prev + 1);

            if (prev === 0) {
                // First subscriber: subscribe and start stale cleanup.
                send({ type: 'TOPIC_SUBSCRIBE', name: topicDef.$name, key } as WorkerInMessage);
                const timer = setInterval(() => {
                    const peers = topicPeers.get(subKey);
                    if (!peers || peers.size === 0) return;
                    const now = Date.now();
                    const next = new Map(
                        [...peers].filter(([, entry]) => now - (entry.$ts as number) <= ttl),
                    );
                    if (next.size !== peers.size) {
                        topicPeers.set(subKey, next);
                        topicSubscribers.get(subKey)?.forEach((fn) => fn());
                    }
                }, 1000);
                topicTimers.set(subKey, timer);
            }

            return () => {
                const count = (topicRefCounts.get(subKey) ?? 1) - 1;
                topicRefCounts.set(subKey, count);

                if (count <= 0) {
                    topicRefCounts.delete(subKey);
                    // Don't send TOPIC_UNSUBSCRIBE — keep the NATS subscription
                    // alive for the tab's lifetime (same pattern as useEntity).
                    // StrictMode's mount→cleanup→mount cycle races async worker
                    // messages; tearing down the sub here causes one tab to lose
                    // its subscription permanently. Cleanup happens on destroy().
                    const timer = topicTimers.get(subKey);
                    if (timer) { clearInterval(timer); topicTimers.delete(subKey); }
                }
            };
        // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [subKey]);

        // Subscribe to peer map changes via useSyncExternalStore.
        const subscribe = useMemo(
            () => (onChange: () => void) => {
                if (!topicSubscribers.has(subKey)) topicSubscribers.set(subKey, new Set());
                topicSubscribers.get(subKey)!.add(onChange);
                return () => { topicSubscribers.get(subKey)?.delete(onChange); };
            },
            [subKey],
        );

        const EMPTY_MAP = useMemo(() => new Map<string, Record<string, unknown>>(), []);
        const peers = useSyncExternalStore(
            subscribe,
            () => topicPeers.get(subKey) ?? EMPTY_MAP,
        );

        // Throttled publish.
        const lastPublishRef = useRef(0);
        const publish = useCallback(
            (data: EntityState<TShape>) => {
                const now = Date.now();
                if (now - lastPublishRef.current < TOPIC_THROTTLE_MS) return;
                lastPublishRef.current = now;
                send({ type: 'TOPIC_PUBLISH', name: topicDef.$name, key, data } as WorkerInMessage);
            },
            // eslint-disable-next-line react-hooks/exhaustive-deps
            [subKey],
        );

        const leave = useCallback(() => {
            send({ type: 'TOPIC_LEAVE', name: topicDef.$name, key } as WorkerInMessage);
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [subKey]);

        return {
            peers: peers as unknown as ReadonlyMap<string, EntityState<TShape> & { readonly $ts: number }>,
            publish,
            leave,
        };
    }

    // ── Bootstrap + return ─────────────────────────────────────────────
    getWorker();

    return {
        use: useHook,
        useTopic: useTopicHook,
        tables: tableNs as TableNamespace<TTables>,
        channels: channelNs as ChannelNamespace<TChannels>,
        destroy(): void {
            worker?.terminate();
            worker = null;
            ready = false;
            seedsApplied = false;
            // Clear every subscriber set so stale useSyncExternalStore
            // closures don't keep firing against a dead store. Components
            // still mounted at destroy time will naturally re-subscribe on
            // the next render if they receive a new Store via context.
            readyListeners.clear();
            viewSubscribers.clear();
            viewSnapshots.clear();
            connectionSubscribers.clear();
            syncStatusSubscribers.clear();
            conflictSubscribers.clear();
            undoSubscribers.clear();
            // Topic cleanup
            for (const timer of topicTimers.values()) clearInterval(timer);
            topicTimers.clear();
            topicPeers.clear();
            topicSubscribers.clear();
            topicRefCounts.clear();
        },
    };
}

// ── Re-exports of user-facing types ───────────────────────────────────────

export type { Table, ColumnDef, ViewBuilder, AnyTable, ChannelConfig, InferRecord };
