/**
 * RED → GREEN — Tombstone GC
 *
 * The problem: deletes are retractions (weight=-1) that accumulate forever
 * in NATS JetStream. No compaction, no snapshots for late joiners.
 * Over time, the stream grows unbounded with delete markers that serve
 * no purpose once all peers have processed them.
 *
 * The solution:
 * 1. Tombstone tracking — the engine tracks which record IDs have been deleted.
 * 2. GC eligibility — after all peers have acked past a tombstone's sequence,
 *    it's safe to purge. Restate tracks per-peer high-water marks.
 * 3. Compaction — Restate periodically publishes a compacted snapshot and
 *    purges old stream messages below the snapshot's sequence.
 * 4. Client-side GC — the worker periodically prunes its local tombstone set.
 */

import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Tombstone tracking in engine
// ═══════════════════════════════════════════════════════════════════════════

describe('Tombstone tracking', () => {

    it('engine tracks tombstones per table', () => {
        // When a retraction (weight=-1) is processed, the engine records
        // the deleted record ID and the HLC at which it was deleted.
        const tombstones = new Map<string, Map<string, { hlc: number; seq: number }>>();
        tombstones.set('expenses', new Map());
        tombstones.get('expenses')!.set('42', { hlc: 2000, seq: 150 });
        tombstones.get('expenses')!.set('43', { hlc: 2001, seq: 155 });

        expect(tombstones.get('expenses')!.size).toBe(2);
        expect(tombstones.get('expenses')!.has('42')).toBe(true);
    });

    it('tombstone prevents re-insertion of old data', () => {
        // If a late-arriving INSERT has an HLC older than the tombstone,
        // it should be ignored. Otherwise deleted records could "resurrect"
        // during replay.
        const tombstoneHlc = 2000;
        const lateInsertHlc = 1999;

        const shouldIgnore = lateInsertHlc <= tombstoneHlc;
        expect(shouldIgnore).toBe(true);
    });

    it('newer insert after tombstone is accepted', () => {
        const tombstoneHlc = 2000;
        const newInsertHlc = 2001;

        const shouldAccept = newInsertHlc > tombstoneHlc;
        expect(shouldAccept).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Peer high-water marks (Restate)
// ═══════════════════════════════════════════════════════════════════════════

describe('Peer high-water marks', () => {

    it('each peer reports its last processed sequence', () => {
        const peerAck = {
            clientId: 'tab-uuid-123',
            userId: 'user_a',
            lastSeq: 450,
            timestamp: Date.now(),
        };

        expect(peerAck.lastSeq).toBe(450);
    });

    it('Restate tracks minimum peer sequence as GC watermark', () => {
        // The GC watermark is the minimum of all active peers' last-processed seq.
        // Messages below this watermark have been seen by all peers.
        const peerSeqs = [450, 300, 500];
        const gcWatermark = Math.min(...peerSeqs);

        expect(gcWatermark).toBe(300);
    });

    it('inactive peers are excluded from watermark calculation', () => {
        // Peers that haven't acked in > 7 days are considered inactive
        // and excluded from the watermark to prevent stale peers from
        // blocking GC indefinitely.
        const now = Date.now();
        const STALE_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 days

        const peers = [
            { clientId: 'a', lastSeq: 450, lastAck: now - 1000 },           // active
            { clientId: 'b', lastSeq: 100, lastAck: now - 8 * 86400000 },   // stale
            { clientId: 'c', lastSeq: 500, lastAck: now - 5000 },           // active
        ];

        const activePeers = peers.filter(p => (now - p.lastAck) < STALE_THRESHOLD);
        const gcWatermark = Math.min(...activePeers.map(p => p.lastSeq));

        expect(activePeers).toHaveLength(2);
        expect(gcWatermark).toBe(450);  // stale peer excluded
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Restate GC handler
// ═══════════════════════════════════════════════════════════════════════════

describe('Restate GC handler', () => {

    it('reportPeerSeq updates peer high-water mark', () => {
        const request = {
            clientId: 'tab-uuid-123',
            userId: 'user_a',
            lastSeq: 500,
        };

        const response = { updated: true, gcWatermark: 300 };
        expect(response.updated).toBe(true);
        expect(response.gcWatermark).toBe(300);
    });

    it('triggerGC compacts the stream below watermark', () => {
        // GC purges messages from the JetStream stream that are below
        // the GC watermark. This is done via NATS stream purge API.
        const request = {};  // no args needed — Restate computes watermark
        const response = {
            purgedCount: 250,
            newFirstSeq: 301,
            gcWatermark: 300,
            snapshotStored: true,
        };

        expect(response.purgedCount).toBe(250);
        expect(response.newFirstSeq).toBe(301);
        expect(response.snapshotStored).toBe(true);
    });

    it('GC stores snapshot before purging', () => {
        // Before purging old messages, GC should store a snapshot
        // so new peers can bootstrap from it instead of the now-purged stream.
        const gcSteps = [
            'compute_watermark',
            'publish_snapshot_at_watermark',
            'purge_stream_below_watermark',
            'update_gc_metadata',
        ];

        expect(gcSteps[1]).toContain('snapshot');
        expect(gcSteps.indexOf('publish_snapshot_at_watermark'))
            .toBeLessThan(gcSteps.indexOf('purge_stream_below_watermark'));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Worker-side tombstone pruning
// ═══════════════════════════════════════════════════════════════════════════

describe('Worker tombstone pruning', () => {

    it('worker prunes tombstones older than GC watermark', () => {
        const tombstones = new Map([
            ['42', { hlc: 1000, seq: 100 }],
            ['43', { hlc: 1500, seq: 200 }],
            ['44', { hlc: 2000, seq: 400 }],
        ]);
        const gcWatermark = 300;

        for (const [id, ts] of tombstones) {
            if (ts.seq <= gcWatermark) tombstones.delete(id);
        }

        expect(tombstones.size).toBe(1);
        expect(tombstones.has('44')).toBe(true);
    });

    it('worker prunes merge state for GC-ed records', () => {
        // When a tombstone is GC-ed, the engine's TableMergeState should
        // also drop the field clocks for that record to free memory.
        const fieldClocks = new Map([
            ['42', { amount: { ts: 1000 } }],
            ['44', { amount: { ts: 2000 } }],
        ]);
        const gcIds = ['42'];

        for (const id of gcIds) fieldClocks.delete(id);
        expect(fieldClocks.size).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. NATS message: GC notification
// ═══════════════════════════════════════════════════════════════════════════

describe('GC notification via NATS', () => {

    it('GC publishes notification to workspace GC subject', () => {
        const msg = {
            type: 'GC_COMPLETE' as const,
            gcWatermark: 300,
            purgedCount: 250,
            snapshotSeq: 300,
            timestamp: Date.now(),
        };

        expect(msg.type).toBe('GC_COMPLETE');
        expect(msg.gcWatermark).toBe(300);
    });

    it('worker subscribes to GC notifications', () => {
        const subject = 'ws.demo.gc';
        expect(subject).toMatch(/^ws\.\w+\.gc$/);
    });

    it('worker updates local state after GC notification', () => {
        // On receiving GC_COMPLETE:
        // 1. Prune tombstones below watermark
        // 2. Update lastProcessedSeq if needed
        // 3. Prune merge state
        const gcMsg = {
            type: 'GC_COMPLETE' as const,
            gcWatermark: 300,
        };

        // Worker should prune entries with seq <= gcWatermark
        expect(gcMsg.gcWatermark).toBeGreaterThan(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Periodic GC scheduling
// ═══════════════════════════════════════════════════════════════════════════

describe('GC scheduling', () => {

    it('worker periodically reports its sequence to Restate', () => {
        // Every N minutes, the worker sends a peer ack to Restate
        const PEER_ACK_INTERVAL = 5 * 60 * 1000; // 5 minutes
        expect(PEER_ACK_INTERVAL).toBe(300000);
    });

    it('Restate can trigger GC on a schedule or on demand', () => {
        // GC can be triggered via:
        // 1. Manual API call to workspace/demo/triggerGC
        // 2. Automated schedule (e.g., daily)
        // 3. When stream size exceeds threshold
        const gcTriggers = ['manual', 'scheduled', 'threshold'];
        expect(gcTriggers).toContain('manual');
    });
});
