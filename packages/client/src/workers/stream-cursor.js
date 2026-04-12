// ── Stream cursor comparison (pure) ─────────────────────────────────────────
//
// Extracted from data-worker.js so unit tests can import the comparator
// without pulling in sqlite-wasm + dbsp WASM. See spec:
// docs/superpowers/specs/2026-04-17-stream-regression-rebase.md
//
// The cursor is `{ created: string, maxAckedSeq: number }` persisted in
// OPFS; the streamInfo argument matches the shape returned by
// `@nats-io/jetstream`'s `jsm.streams.info()`.

/**
 * Pure comparison of a persisted client cursor against a JetStream
 * streamInfo snapshot.
 *
 * Returns:
 *   - null when there's no cursor (first boot — nothing to compare),
 *     when we're caught up, or during normal forward catch-up.
 *   - { reason, previous, current } when regression is detected.
 *
 * Reasons:
 *   'stream-recreated'    — info.created differs from cursor.created
 *   'last-seq-regressed'  — info.lastSeq < cursor.maxAckedSeq
 *   'history-aged-out'    — info.firstSeq > cursor.maxAckedSeq + 1
 *
 * `stream-recreated` takes priority because a recreated stream would
 * usually also produce one of the sequence-based signals — we want the
 * more specific diagnostic to surface.
 */
export function compareStreamCursor(cursor, streamInfo) {
    if (!cursor) return null;

    const info = {
        created: String(streamInfo?.created ?? ''),
        firstSeq: Number(streamInfo?.state?.first_seq ?? 0),
        lastSeq: Number(streamInfo?.state?.last_seq ?? 0),
    };

    if (cursor.created !== info.created) {
        return { reason: 'stream-recreated', previous: cursor, current: info };
    }
    if (info.lastSeq < cursor.maxAckedSeq) {
        return { reason: 'last-seq-regressed', previous: cursor, current: info };
    }
    if (info.firstSeq > cursor.maxAckedSeq + 1) {
        return { reason: 'history-aged-out', previous: cursor, current: info };
    }
    return null;
}
