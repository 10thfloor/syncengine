/**
 * Unit tests for the pure stream-regression comparison.
 *
 * Protects the three detection signals the spec commits to:
 *   - stream-recreated       (created timestamps differ)
 *   - last-seq-regressed     (stream tail < client ack cursor)
 *   - history-aged-out       (stream head > client ack cursor + 1)
 *
 * The function must ignore normal catch-up (cursor behind tail), first
 * boot (no cursor), and empty-stream cases where the cursor still
 * matches. Anything broken here means the devtools reset flow silently
 * fails to trigger a rebuild on the connected client.
 *
 * See: docs/superpowers/specs/2026-04-17-stream-regression-rebase.md
 */

import { describe, it, expect } from 'vitest';

import { compareStreamCursor } from '../workers/stream-cursor.js';

interface Cursor {
    created: string;
    maxAckedSeq: number;
}
interface StreamInfo {
    created: string;
    state: { first_seq: number; last_seq: number };
}

function stream(created: string, firstSeq: number, lastSeq: number): StreamInfo {
    return { created, state: { first_seq: firstSeq, last_seq: lastSeq } };
}

describe('compareStreamCursor', () => {
    it('returns null on first boot (no cursor)', () => {
        expect(compareStreamCursor(null, stream('2026-04-17T00:00:00Z', 1, 10))).toBeNull();
    });

    it('returns null when cursor matches and we are caught up', () => {
        const cursor: Cursor = { created: '2026-04-17T00:00:00Z', maxAckedSeq: 10 };
        expect(compareStreamCursor(cursor, stream('2026-04-17T00:00:00Z', 1, 10))).toBeNull();
    });

    it('returns null during normal catch-up (cursor < tail)', () => {
        const cursor: Cursor = { created: '2026-04-17T00:00:00Z', maxAckedSeq: 5 };
        expect(compareStreamCursor(cursor, stream('2026-04-17T00:00:00Z', 1, 20))).toBeNull();
    });

    it('flags stream-recreated when created timestamps differ', () => {
        const cursor: Cursor = { created: '2026-04-17T00:00:00Z', maxAckedSeq: 10 };
        const result = compareStreamCursor(cursor, stream('2026-04-17T12:00:00Z', 1, 3));
        expect(result).not.toBeNull();
        expect(result!.reason).toBe('stream-recreated');
        expect(result!.previous).toEqual(cursor);
        expect(result!.current.created).toBe('2026-04-17T12:00:00Z');
    });

    it('flags last-seq-regressed when stream tail is behind cursor', () => {
        const cursor: Cursor = { created: 'C1', maxAckedSeq: 100 };
        const result = compareStreamCursor(cursor, stream('C1', 1, 50));
        expect(result).toMatchObject({ reason: 'last-seq-regressed' });
    });

    it('flags history-aged-out when the stream head is past our cursor', () => {
        // Cursor acked up to 5, but the stream's oldest retained message
        // is now at seq 20 — messages 6..19 have aged out of retention,
        // so we can't incrementally catch up.
        const cursor: Cursor = { created: 'C1', maxAckedSeq: 5 };
        const result = compareStreamCursor(cursor, stream('C1', 20, 100));
        expect(result).toMatchObject({ reason: 'history-aged-out' });
    });

    it('prioritizes stream-recreated over sequence-based signals', () => {
        // If created differs AND last_seq happens to also be less than
        // cursor (a recreated stream will typically have low seqs), the
        // 'stream-recreated' reason wins because it's the more specific
        // diagnostic.
        const cursor: Cursor = { created: 'OLD', maxAckedSeq: 100 };
        const result = compareStreamCursor(cursor, stream('NEW', 1, 3));
        expect(result).not.toBeNull();
        expect(result!.reason).toBe('stream-recreated');
    });

    it('does not flag the boundary case of cursor exactly at first_seq - 1', () => {
        // Client acked 0, stream first_seq = 1 — normal first-boot-ish state.
        const cursor: Cursor = { created: 'C1', maxAckedSeq: 0 };
        expect(compareStreamCursor(cursor, stream('C1', 1, 10))).toBeNull();
    });

    it('does not flag when cursor is exactly at last_seq', () => {
        const cursor: Cursor = { created: 'C1', maxAckedSeq: 42 };
        expect(compareStreamCursor(cursor, stream('C1', 1, 42))).toBeNull();
    });
});
