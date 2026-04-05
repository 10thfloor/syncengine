import { useSyncExternalStore, useCallback, useMemo, useState, useEffect } from 'react';
import {
    extractMergeConfig,
    tableToCreateSQL,
    tableToInsertSQL,
    CONFLICT_LOG_MAX,
    type TableDef,
    type ViewDef,
    type Migration,
    type SyncConfig,
    type ConnectionStatus,
    type SyncStatus,
    type ConflictRecord,
} from '@syncengine/core';

// Re-export protocol types for consumers of @syncengine/client
export type { SyncConfig, ConnectionStatus, SyncStatus, ConflictRecord };

// ── Worker message types ────────────────────────────────────────────────────

interface InitMessage {
    type: 'INIT';
    schema: {
        tables: Array<{ name: string; sql: string; insertSql: string; columns: string[] }>;
        views: Array<{
            name: string;
            tableName: string;
            source_table: string;
            id_key: string;
            pipeline: unknown[];
            sourceTables: string[];
            monotonicity: string;
        }>;
        mergeConfigs: Array<{ table: string; fields: Record<string, string> }>;
    };
    sync?: SyncConfig;
    schemaVersion?: number;
    migrations?: Migration[];
}

interface InsertMessage { type: 'INSERT'; table: string; record: Record<string, unknown>; _noUndo?: boolean; _localOnly?: boolean }
interface DeleteMessage { type: 'DELETE'; table: string; id: unknown }
interface ResetMessage { type: 'RESET' }
interface UndoMessage { type: 'UNDO' }

type WorkerOutMessage =
    | { type: 'WORKER_LOADED' }
    | { type: 'READY' }
    | { type: 'VIEW_UPDATE'; viewName: string; deltas: Array<{ record: Record<string, unknown>; weight: number }> }
    | { type: 'FULL_SYNC'; snapshots: Record<string, Record<string, unknown>[]> }
    | { type: 'UNDO_SIZE'; size: number }
    | { type: 'CONNECTION_STATUS'; status: ConnectionStatus }
    | { type: 'SYNC_STATUS'; phase: 'idle' | 'replaying' | 'live'; messagesReplayed: number; totalMessages?: number; snapshotLoaded?: boolean }
    | { type: 'MIGRATION_STATUS'; fromVersion: number; toVersion: number; status: 'running' | 'complete' | 'failed'; stepsApplied: number; error?: string; failedAtVersion?: number }
    | { type: 'CONFLICTS'; conflicts: Array<{ table: string; recordId: string; field: string; winner: unknown; loser: unknown; winnerHlc: number; loserHlc: number; strategy: string }> };

type WorkerInMessage = InitMessage | InsertMessage | DeleteMessage | ResetMessage | UndoMessage;

// ── Subscriber hook factory ────────────────────────────────────────────────
// Eliminates the repeated useSyncExternalStore boilerplate across hooks.

function useExternalStore<T>(
    subscribers: Set<() => void>,
    getValue: () => T,
): T {
    const subscribe = useCallback((onChange: () => void) => {
        subscribers.add(onChange);
        return () => { subscribers.delete(onChange); };
    }, [subscribers]);

    return useSyncExternalStore(subscribe, getValue);
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface StoreConfig {
    tables: TableDef[];
    views: ViewDef[];
    sync?: SyncConfig;
    schemaVersion?: number;
    migrations?: Migration[];
}

export interface Store {
    useView: <T>(viewDef: ViewDef<T>) => {
        data: T[];
        insert: (record: T) => void;
        remove: (id: unknown) => void;
        ready: boolean;
    };
    useUndoSize: () => number;
    useConnectionStatus: () => ConnectionStatus;
    useSyncStatus: () => SyncStatus;
    useConflicts: () => ConflictRecord[];
    insert: (tableName: string, record: Record<string, unknown>) => void;
    /** Insert without adding to undo stack (for seed data) */
    insertSeed: (tableName: string, record: Record<string, unknown>) => void;
    remove: (tableName: string, id: unknown) => void;
    undo: () => void;
    reset: () => void;
    destroy: () => void;
    dismissConflict: (index: number) => void;
}

export function store(config: StoreConfig): Store {
    const schemaPayload: InitMessage['schema'] = {
        tables: config.tables.map(t => ({
            name: t.name,
            sql: tableToCreateSQL(t),
            insertSql: tableToInsertSQL(t),
            columns: Object.keys(t.columns),
        })),
        views: config.views.map(v => ({
            name: v.name,
            tableName: v.tableName,
            source_table: v.tableName,
            id_key: v.idKey,
            pipeline: v.pipeline,
            sourceTables: v.sourceTables,
            monotonicity: v.monotonicity,
        })),
        mergeConfigs: config.tables
            .map(t => extractMergeConfig(t))
            .filter((c): c is NonNullable<typeof c> => c !== null),
    };

    let worker: Worker | null = null;
    let ready = false;
    const readyListeners = new Set<() => void>();

    // ── View state ──────────────────────────────────────────────────────────
    const viewSnapshots = new Map<string, unknown[]>();
    const viewSubscribers = new Map<string, Set<() => void>>();
    const EMPTY: unknown[] = [];

    // ── Undo tracking ───────────────────────────────────────────────────────
    let undoSize = 0;
    const undoSubscribers = new Set<() => void>();

    // ── Connection status ───────────────────────────────────────────────────
    let connectionStatus: ConnectionStatus = config.sync ? 'connecting' : 'off';
    const connectionSubscribers = new Set<() => void>();

    // ── Sync status ─────────────────────────────────────────────────────────
    let syncStatus: SyncStatus = { phase: 'idle', messagesReplayed: 0, snapshotLoaded: false };
    const syncStatusSubscribers = new Set<() => void>();

    // ── Conflict log ────────────────────────────────────────────────────────
    let conflictLog: ConflictRecord[] = [];
    const conflictSubscribers = new Set<() => void>();

    // ── View helpers ────────────────────────────────────────────────────────

    function notifyView(viewName: string) {
        viewSubscribers.get(viewName)?.forEach(fn => fn());
    }

    function getSnapshot<T>(viewName: string): T[] {
        return (viewSnapshots.get(viewName) ?? EMPTY) as T[];
    }

    function applyDeltas(viewName: string, deltas: Array<{ record: Record<string, unknown>; weight: number }>) {
        const idKey = config.views.find(v => v.name === viewName)?.idKey ?? 'id';
        const current = (viewSnapshots.get(viewName) ?? []) as Record<string, unknown>[];
        const next = [...current];

        for (const delta of deltas) {
            const recId = String(delta.record[idKey]);
            const idx = next.findIndex(item => String(item[idKey]) === recId);
            if (idx !== -1) next.splice(idx, 1);
            if (delta.weight > 0) next.push(delta.record);
        }

        viewSnapshots.set(viewName, next);
        notifyView(viewName);
    }

    // ── Worker lifecycle ────────────────────────────────────────────────────

    function getWorker(): Worker {
        if (worker) return worker;

        worker = new Worker(
            new URL('./workers/data-worker.js', import.meta.url),
            { type: 'module' },
        );

        worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
            const msg = event.data;

            // Handshake: wait for the worker module to finish loading
            // before sending INIT. Module workers with top-level await
            // may drop messages posted before evaluation completes.
            if (msg.type === 'WORKER_LOADED') {
                const initMsg: InitMessage = { type: 'INIT', schema: schemaPayload };
                if (config.sync) initMsg.sync = config.sync;
                if (config.schemaVersion) initMsg.schemaVersion = config.schemaVersion;
                if (config.migrations) initMsg.migrations = config.migrations;
                worker!.postMessage(initMsg);
                return;
            }

            switch (msg.type) {
                case 'READY':
                    ready = true;
                    readyListeners.forEach(fn => fn());
                    readyListeners.clear();
                    break;

                case 'VIEW_UPDATE':
                    applyDeltas(msg.viewName, msg.deltas);
                    break;

                case 'UNDO_SIZE':
                    undoSize = msg.size;
                    undoSubscribers.forEach(fn => fn());
                    break;

                case 'CONNECTION_STATUS':
                    connectionStatus = msg.status;
                    connectionSubscribers.forEach(fn => fn());
                    break;

                case 'SYNC_STATUS':
                    syncStatus = {
                        phase: msg.phase,
                        messagesReplayed: msg.messagesReplayed,
                        totalMessages: msg.totalMessages,
                        snapshotLoaded: msg.snapshotLoaded ?? syncStatus.snapshotLoaded,
                    };
                    syncStatusSubscribers.forEach(fn => fn());
                    if (msg.phase === 'live') {
                        connectionStatus = 'connected';
                        connectionSubscribers.forEach(fn => fn());
                    }
                    break;

                case 'FULL_SYNC':
                    for (const [viewName, records] of Object.entries(msg.snapshots)) {
                        viewSnapshots.set(viewName, records);
                        notifyView(viewName);
                    }
                    for (const viewName of viewSnapshots.keys()) {
                        if (!(viewName in msg.snapshots)) {
                            viewSnapshots.set(viewName, []);
                            notifyView(viewName);
                        }
                    }
                    if (Object.keys(msg.snapshots).length === 0) {
                        conflictLog = [];
                        conflictSubscribers.forEach(fn => fn());
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
                    conflictSubscribers.forEach(fn => fn());
                    break;
                }
            }
        };

        return worker;
    }

    // ── Imperative API ──────────────────────────────────────────────────────

    function send(msg: WorkerInMessage) {
        getWorker().postMessage(msg);
    }

    function insert(tableName: string, record: Record<string, unknown>) {
        send({ type: 'INSERT', table: tableName, record });
    }

    function insertSeed(tableName: string, record: Record<string, unknown>) {
        send({ type: 'INSERT', table: tableName, record, _noUndo: true, _localOnly: true });
    }

    function remove(tableName: string, id: unknown) {
        send({ type: 'DELETE', table: tableName, id });
    }

    function undo() { send({ type: 'UNDO' }); }
    function reset() { send({ type: 'RESET' }); }

    function destroy() {
        worker?.terminate();
        worker = null;
        ready = false;
    }

    function dismissConflict(index: number) {
        if (conflictLog[index]) {
            conflictLog = [...conflictLog];
            conflictLog[index] = { ...conflictLog[index], dismissed: true };
            conflictSubscribers.forEach(fn => fn());
        }
    }

    // ── React hooks ─────────────────────────────────────────────────────────

    function useView<T>(viewDef: ViewDef<T>) {
        const viewName = viewDef.name;

        const subscribeFn = useMemo(() => (onStoreChange: () => void) => {
            if (!viewSubscribers.has(viewName)) {
                viewSubscribers.set(viewName, new Set());
            }
            viewSubscribers.get(viewName)!.add(onStoreChange);
            return () => { viewSubscribers.get(viewName)?.delete(onStoreChange); };
        }, [viewName]);

        const data = useSyncExternalStore<T[]>(
            subscribeFn,
            () => getSnapshot<T>(viewName),
        );

        const [isReady, setIsReady] = useState(ready);
        useEffect(() => {
            getWorker();
            if (ready) {
                setIsReady(true);
            } else {
                const onReady = () => setIsReady(true);
                readyListeners.add(onReady);
                return () => { readyListeners.delete(onReady); };
            }
        }, []);

        const insertFn = useCallback(
            (record: T) => insert(viewDef.tableName, record as Record<string, unknown>),
            [viewDef.tableName],
        );

        const removeFn = useCallback(
            (id: unknown) => remove(viewDef.tableName, id),
            [viewDef.tableName],
        );

        return { data, insert: insertFn, remove: removeFn, ready: isReady };
    }

    function useUndoSize(): number {
        return useExternalStore(undoSubscribers, () => undoSize);
    }

    function useConnectionStatus(): ConnectionStatus {
        return useExternalStore(connectionSubscribers, () => connectionStatus);
    }

    function useSyncStatus(): SyncStatus {
        return useExternalStore(syncStatusSubscribers, () => syncStatus);
    }

    function useConflicts(): ConflictRecord[] {
        return useExternalStore(conflictSubscribers, () => conflictLog);
    }

    // ── Bootstrap & return ──────────────────────────────────────────────────

    getWorker();
    return { useView, useUndoSize, useConnectionStatus, useSyncStatus, useConflicts, insert, insertSeed, remove, undo, reset, destroy, dismissConflict };
}
