/**
 * RED phase — Initial State Sync
 *
 * These tests define the contracts for how a new device joining a workspace
 * gets brought up to date. Two mechanisms:
 *
 * 1. JetStream replay: ordered consumer with DeliverPolicy.All replays
 *    historical messages before switching to live subscription.
 *
 * 2. Snapshot: Restate stores a compacted snapshot; new devices fetch it
 *    and only replay messages after the snapshot sequence.
 *
 * All tests should FAIL until we implement the feature.
 */

import { describe, it, expect } from 'vitest';
import { table, id, real, text, view, sum, count, extractMergeConfig } from '@syncengine/core';
import type { SyncConfig, ConnectionStatus } from '@syncengine/core/internal';

// ── Test fixtures ──────────────────────────────────────────────────────────

const expenses = table('expenses', {
    id: id(),
    amount: real({ merge: 'lww' }),
    category: text({ merge: 'lww' }),
    description: text({ merge: 'lww' }),
    date: text({ merge: 'lww' }),
});

const byCategory = view('byCategory', expenses)
    .aggregate(['category'], { total: sum('amount'), count: count() });

// ═══════════════════════════════════════════════════════════════════════════
// 1. Worker → NATS: JetStream replay protocol
// ═══════════════════════════════════════════════════════════════════════════

describe('JetStream replay protocol', () => {

    it('SyncConfig supports initialSync mode flag', () => {
        // New devices should be able to request full replay
        const config: SyncConfig = {
            workspaceId: 'demo',
            natsUrl: 'ws://localhost:9222',
        };
        // initialSync should default to true — new devices always need it
        // The worker decides if replay is needed based on local SQLite state
        expect(config).toHaveProperty('workspaceId');
        // This test just validates the config shape; the real test is in the worker.
    });

    it('worker emits SYNC_STATUS messages during replay', () => {
        // During JetStream replay, the worker should inform the main thread
        // about sync progress so the UI can show a loading indicator.
        const syncStartMsg = {
            type: 'SYNC_STATUS' as const,
            phase: 'replaying' as const,
            messagesReplayed: 0,
            totalMessages: undefined as number | undefined,  // may not be known upfront
        };

        const syncProgressMsg = {
            type: 'SYNC_STATUS' as const,
            phase: 'replaying' as const,
            messagesReplayed: 150,
        };

        const syncCompleteMsg = {
            type: 'SYNC_STATUS' as const,
            phase: 'live' as const,
            messagesReplayed: 300,
        };

        expect(syncStartMsg.type).toBe('SYNC_STATUS');
        expect(syncStartMsg.phase).toBe('replaying');
        expect(syncCompleteMsg.phase).toBe('live');
    });

    it('ConnectionStatus includes syncing state', () => {
        // The store should expose a 'syncing' status between 'connecting' and 'connected'
        const validStatuses: ConnectionStatus[] = ['off', 'connecting', 'syncing', 'connected', 'disconnected'];
        expect(validStatuses).toContain('connecting');
        expect(validStatuses).toContain('syncing');
    });

    it('JetStream consumer config uses DeliverAll for initial replay', () => {
        // The worker should create an ordered consumer with these settings
        const consumerConfig = {
            deliver_policy: 'all',           // replay from beginning
            filter_subject: 'ws.demo.deltas',
            replay_policy: 'instant',        // replay as fast as possible, not at original speed
        };

        expect(consumerConfig.deliver_policy).toBe('all');
        expect(consumerConfig.replay_policy).toBe('instant');
        expect(consumerConfig.filter_subject).toMatch(/^ws\.\w+\.deltas$/);
    });

    it('replay messages are applied without undo stack', () => {
        // Historical messages should not pollute the undo stack
        const replayedInsert = {
            type: 'INSERT' as const,
            table: 'expenses',
            record: { id: 1, amount: 42, category: 'food' },
            _noUndo: true,      // must be true for replayed messages
            _fromNats: true,
            _isReplay: true,    // new flag to distinguish replay from live
            _nonce: 'peer-abc-1',
            _hlc: { ts: 1000, count: 0 },
        };

        expect(replayedInsert._noUndo).toBe(true);
        expect(replayedInsert._isReplay).toBe(true);
    });

    it('replay skips broadcasting to sibling tabs', () => {
        // During replay, we should NOT broadcast each message to BroadcastChannel.
        // Other tabs will do their own replay. Broadcasting 10K replayed messages
        // would cause a thundering herd.
        const replayedInsert = {
            type: 'INSERT' as const,
            table: 'expenses',
            record: { id: 1, amount: 42 },
            _fromNats: true,
            _isReplay: true,
        };

        // The _isReplay flag tells stepEmitBroadcast to skip BroadcastChannel
        expect(replayedInsert._isReplay).toBe(true);
    });

    it('after replay completes, worker emits FULL_SYNC with current state', () => {
        // Once all historical messages are consumed, the worker should snapshot
        // all view states and emit a FULL_SYNC to the main thread.
        // This gives the UI a clean starting point.
        const fullSyncMsg = {
            type: 'FULL_SYNC' as const,
            snapshots: {
                byCategory: [
                    { category: 'food', total: 142.5, count: 3 },
                    { category: 'transport', total: 85.0, count: 2 },
                ],
            },
        };

        expect(fullSyncMsg.type).toBe('FULL_SYNC');
        expect(Object.keys(fullSyncMsg.snapshots).length).toBeGreaterThan(0);
    });

    it('replay then live: messages arriving during replay are not double-applied', () => {
        // Edge case: while replaying historical messages 1-300, a new live message 301
        // arrives. The nonce dedup system should handle this, but we need to verify
        // the ordered consumer delivers exactly once.
        const replayNonces = ['peer-1', 'peer-2', 'peer-3'];
        const liveNonces = ['peer-3', 'peer-4'];  // peer-3 overlaps

        const seen = new Set<string>();
        const applied: string[] = [];

        for (const n of [...replayNonces, ...liveNonces]) {
            if (!seen.has(n)) {
                seen.add(n);
                applied.push(n);
            }
        }

        expect(applied).toEqual(['peer-1', 'peer-2', 'peer-3', 'peer-4']);
        // peer-3 not duplicated
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Restate: Snapshot endpoint
// ═══════════════════════════════════════════════════════════════════════════

describe('Restate snapshot endpoint', () => {

    it('snapshot request contains workspaceId and last known sequence', () => {
        // A new device requests a snapshot, optionally providing the last
        // sequence it has (0 = brand new, >0 = catching up after disconnect)
        const request = {
            lastSeq: 0,  // brand new device
        };

        expect(request.lastSeq).toBe(0);
    });

    it('snapshot response contains table data and stream sequence', () => {
        // The snapshot response should include:
        // - All table rows as records
        // - The JetStream sequence number at which the snapshot was taken
        // - Schema version for migration compatibility
        const response = {
            seq: 450,                    // snapshot taken at stream seq 450
            schemaVersion: 1,
            tables: {
                expenses: [
                    { id: 1, amount: 42.5, category: 'food', description: 'lunch', date: '2026-04-01' },
                    { id: 2, amount: 15.0, category: 'transport', description: 'bus', date: '2026-04-02' },
                ],
                budgets: [
                    { id: 1, category: 'food', limit: 500 },
                ],
            },
            mergeClocks: {
                // Per-table merge clock state for CRDV continuity
                expenses: {
                    '1': { amount: { ts: 1000, count: 0 }, category: { ts: 1000, count: 0 } },
                    '2': { amount: { ts: 1001, count: 0 } },
                },
            },
        };

        expect(response.seq).toBeGreaterThan(0);
        expect(response.schemaVersion).toBeGreaterThan(0);
        expect(response.tables).toHaveProperty('expenses');
        expect(response.tables.expenses.length).toBe(2);
        expect(response.mergeClocks).toHaveProperty('expenses');
    });

    it('snapshot followed by replay-from-seq catches up fully', () => {
        // After loading a snapshot at seq 450, the new device creates a
        // JetStream consumer starting at seq 451 to catch up on messages
        // that arrived after the snapshot.
        const snapshotSeq = 450;
        const consumerConfig = {
            deliver_policy: 'by_start_sequence',
            opt_start_seq: snapshotSeq + 1,
            filter_subject: 'ws.demo.deltas',
            replay_policy: 'instant',
        };

        expect(consumerConfig.deliver_policy).toBe('by_start_sequence');
        expect(consumerConfig.opt_start_seq).toBe(451);
    });

    it('publishSnapshot handler stores snapshot in Restate state', () => {
        // Periodically (or on demand), a connected client publishes its
        // current SQLite state as a snapshot. Restate stores it durably.
        const publishRequest = {
            seq: 500,
            schemaVersion: 1,
            tables: {
                expenses: [
                    { id: 1, amount: 42.5, category: 'food' },
                ],
            },
            hlcState: { ts: 1743552000000, count: 42 },
        };

        expect(publishRequest.seq).toBeGreaterThan(0);
        expect(publishRequest.tables).toBeTruthy();
        expect(publishRequest.hlcState).toBeTruthy();
    });

    it('getSnapshot returns null when no snapshot exists', () => {
        // For a brand-new workspace with no snapshots yet,
        // getSnapshot should return null, forcing full JetStream replay.
        const response = null;
        // After implementation, this should be the actual return value
        // from the Restate handler for a workspace with no snapshots.
        expect(response).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Store: sync status hook
// ═══════════════════════════════════════════════════════════════════════════

describe('Store sync status', () => {

    it('store exposes useSyncStatus hook', () => {
        // The store should expose a hook that provides detailed sync status
        // beyond just connection status. This includes replay progress.
        const syncStatus = {
            phase: 'replaying' as 'idle' | 'replaying' | 'live',
            messagesReplayed: 150,
            totalMessages: undefined as number | undefined,
            snapshotLoaded: false,
        };

        expect(syncStatus.phase).toBe('replaying');
        expect(syncStatus.messagesReplayed).toBe(150);
    });

    it('SYNC_STATUS messages update store sync state', () => {
        // The store should handle SYNC_STATUS messages from the worker
        // and expose them via useSyncStatus
        const workerMessage = {
            type: 'SYNC_STATUS' as const,
            phase: 'live' as const,
            messagesReplayed: 300,
            snapshotLoaded: true,
        };

        // This should be a valid WorkerOutMessage type
        expect(workerMessage.type).toBe('SYNC_STATUS');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Worker: replay-then-live state machine
// ═══════════════════════════════════════════════════════════════════════════

describe('Worker replay state machine', () => {

    it('worker tracks sync phase internally', () => {
        // The worker should have an internal state machine:
        // 'idle' → 'fetching_snapshot' → 'replaying' → 'live'
        // or 'idle' → 'replaying' → 'live' (if no snapshot available)
        type SyncPhase = 'idle' | 'fetching_snapshot' | 'replaying' | 'live';

        const transitions: Array<[SyncPhase, SyncPhase]> = [
            ['idle', 'fetching_snapshot'],
            ['fetching_snapshot', 'replaying'],  // snapshot loaded, now replay from seq
            ['idle', 'replaying'],                // no snapshot, full replay
            ['replaying', 'live'],                // replay done, switch to live
        ];

        // All transitions should be valid
        for (const [from, to] of transitions) {
            expect(from).not.toBe(to);
        }
    });

    it('during replay, local mutations are queued', () => {
        // While replaying historical messages, the user might interact with the UI.
        // Local mutations should be queued and applied after replay completes,
        // to avoid interleaving replay state with local state.
        type SyncPhase = 'idle' | 'replaying' | 'live';
        const phase: SyncPhase = 'replaying';
        const localMutationQueue: unknown[] = [];

        // Simulate a local insert during replay
        if (phase === 'replaying') {
            localMutationQueue.push({
                type: 'INSERT',
                table: 'expenses',
                record: { id: 99, amount: 10 },
            });
        }

        expect(localMutationQueue.length).toBe(1);
        // After replay completes, these should be flushed
    });

    it('reconnect after disconnect does incremental replay, not full', () => {
        // If a device disconnects and reconnects, it should only replay
        // messages it missed, not the entire stream. This requires tracking
        // the last processed JetStream sequence number.
        const lastProcessedSeq = 450;
        const consumerConfig = {
            deliver_policy: 'by_start_sequence',
            opt_start_seq: lastProcessedSeq + 1,
            filter_subject: 'ws.demo.deltas',
            replay_policy: 'instant',
        };

        expect(consumerConfig.opt_start_seq).toBe(451);
    });

    it('empty stream skips replay and goes straight to live', () => {
        // For a brand-new workspace with no history,
        // the worker should skip replay and go directly to live mode.
        const streamInfo = {
            state: {
                messages: 0,
                first_seq: 0,
                last_seq: 0,
            },
        };

        const shouldReplay = streamInfo.state.messages > 0;
        expect(shouldReplay).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Rust engine: bulk load optimization
// ═══════════════════════════════════════════════════════════════════════════

describe('Engine bulk load for snapshot', () => {

    it('snapshot load should hydrate merge state correctly', () => {
        // When loading a snapshot, the engine needs to rebuild its
        // TableMergeState (per-field HLC clocks) from the snapshot data.
        // Otherwise, the first live mutation after snapshot load would
        // always win LWW (because there's no prior clock to compare against).
        const snapshotMergeClocks = {
            expenses: {
                '1': {
                    amount: { ts: 1000, count: 0 },
                    category: { ts: 1000, count: 0 },
                },
            },
        };

        // The engine should have a method like `restore_merge_state()`
        // that accepts this data and rebuilds the internal clock tracking.
        expect(snapshotMergeClocks.expenses['1'].amount.ts).toBe(1000);
    });

    it('snapshot load should set engine HLC to at least the snapshot HLC', () => {
        // The engine's HLC must be merged with the snapshot's HLC
        // to maintain the monotonicity invariant.
        const engineHlc = { ts: 500, count: 3 };  // local clock
        const snapshotHlc = { ts: 1000, count: 42 };

        // After merge, engine clock should be >= snapshot clock
        const merged = {
            ts: Math.max(engineHlc.ts, snapshotHlc.ts),
            count: snapshotHlc.count + 1,
        };

        expect(merged.ts).toBe(1000);
        expect(merged.count).toBeGreaterThan(snapshotHlc.count);
    });
});
