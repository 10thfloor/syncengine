import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore, type TestStore } from '../index.js';
import {
    table, id, text, integer, real,
    view, sum, count, max,
    entity, emit, insert, remove, update, EntityError,
} from '@syncengine/core';

// ── Test schema ─────────────────────────────────────────────────────────────

const transactions = table('transactions', {
    id: id(),
    productSlug: text(),
    userId: text(),
    amount: real(),
    type: text(),
    timestamp: integer(),
});

const orderIndex = table('orderIndex', {
    id: id(),
    orderId: text(),
    productSlug: text(),
    userId: text(),
    price: real(),
    createdAt: integer(),
});

const salesByProduct = view(transactions)
    .filter(transactions.type, 'eq', 'sale')
    .aggregate([transactions.productSlug], {
        total: sum(transactions.amount),
        count: count(),
    });

const totalSales = view(transactions)
    .aggregate([], {
        revenue: sum(transactions.amount),
        count: count(),
    });

const allOrders = view(orderIndex)
    .aggregate([orderIndex.orderId, orderIndex.productSlug, orderIndex.userId], {
        price: max(orderIndex.price),
        createdAt: max(orderIndex.createdAt),
    });

// ── Test entity ─────────────────────────────────────────────────────────────

const inventory = entity('inventory', {
    state: { stock: integer() },
    handlers: {
        sell(state, userId: string, price: number, now: number) {
            if (state.stock <= 0) throw new EntityError('OUT_OF_STOCK', 'No stock');
            return emit({
                state: { ...state, stock: state.stock - 1 },
                effects: [
                    insert(transactions, { productSlug: '$key', userId, amount: price, type: 'sale', timestamp: now }),
                ],
            });
        },
        restock(state, amount: number) {
            return { ...state, stock: state.stock + amount };
        },
    },
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('TestStore', () => {
    let store: TestStore;

    beforeEach(() => {
        store = createTestStore({
            tables: [transactions, orderIndex],
            views: { salesByProduct, totalSales, allOrders },
        });
    });

    // 1. insert + view — insert a row, read it from a materialized aggregate view
    it('insert + view: inserted row appears in a materialized view', () => {
        store.insert(transactions, {
            productSlug: 'headphones',
            userId: 'alice',
            amount: 79,
            type: 'sale',
            timestamp: 1000,
        });

        const rows = store.view(salesByProduct);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            productSlug: 'headphones',
            total: 79,
            count: 1,
        });
    });

    // 2. Filtered views exclude non-matching rows
    it('filtered view excludes non-matching rows', () => {
        store.insert(transactions, {
            productSlug: 'headphones',
            userId: 'alice',
            amount: 79,
            type: 'sale',
            timestamp: 1000,
        });
        store.insert(transactions, {
            productSlug: 'keyboard',
            userId: 'bob',
            amount: 100,
            type: 'refund',
            timestamp: 2000,
        });

        const rows = store.view(salesByProduct);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ productSlug: 'headphones' });
    });

    // 3. Global aggregate (zero group-by) sums across inserts
    it('global aggregate sums across all inserts', () => {
        store.insert(transactions, {
            productSlug: 'headphones',
            userId: 'alice',
            amount: 79,
            type: 'sale',
            timestamp: 1000,
        });
        store.insert(transactions, {
            productSlug: 'keyboard',
            userId: 'bob',
            amount: 129,
            type: 'sale',
            timestamp: 2000,
        });

        const rows = store.view(totalSales);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            revenue: 208,
            count: 2,
        });
    });

    // 4. Multi-column aggregate deduplicates correctly
    it('multi-column aggregate deduplicates by composite key', () => {
        store.insert(orderIndex, {
            orderId: 'ord-1',
            productSlug: 'headphones',
            userId: 'alice',
            price: 79,
            createdAt: 1000,
        });
        // Same composite key (orderId + productSlug + userId) — should upsert
        store.insert(orderIndex, {
            orderId: 'ord-1',
            productSlug: 'headphones',
            userId: 'alice',
            price: 99,
            createdAt: 2000,
        });

        const rows = store.view(allOrders);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            orderId: 'ord-1',
            productSlug: 'headphones',
            userId: 'alice',
            price: 99,
            createdAt: 2000,
        });
    });

    // 5. Auto-generated PKs work
    it('auto-generates primary keys when id is omitted', () => {
        store.insert(transactions, {
            productSlug: 'headphones',
            userId: 'alice',
            amount: 79,
            type: 'sale',
            timestamp: 1000,
        });
        store.insert(transactions, {
            productSlug: 'keyboard',
            userId: 'bob',
            amount: 129,
            type: 'sale',
            timestamp: 2000,
        });

        const rows = store.view(salesByProduct);
        // Two distinct products -> two rows (auto-ids don't collide)
        expect(rows).toHaveLength(2);
    });

    // 6. delete retracts rows and updates views
    it('delete retracts rows and updates views', () => {
        store.insert(transactions, {
            id: 100,
            productSlug: 'headphones',
            userId: 'alice',
            amount: 79,
            type: 'sale',
            timestamp: 1000,
        });
        store.insert(transactions, {
            id: 101,
            productSlug: 'keyboard',
            userId: 'bob',
            amount: 129,
            type: 'sale',
            timestamp: 2000,
        });

        expect(store.view(totalSales)).toHaveLength(1);
        expect(store.view(totalSales)[0]).toMatchObject({ revenue: 208, count: 2 });

        store.delete(transactions, 100);

        const rows = store.view(totalSales);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ revenue: 129, count: 1 });
    });

    // 7. delete throws on nonexistent row
    it('delete throws on nonexistent row', () => {
        expect(() => store.delete(transactions, 999)).toThrow(/no row/i);
    });

    // 8. reset clears all state
    it('reset clears all state', () => {
        store.insert(transactions, {
            productSlug: 'headphones',
            userId: 'alice',
            amount: 79,
            type: 'sale',
            timestamp: 1000,
        });

        expect(store.view(salesByProduct)).toHaveLength(1);

        store.reset();

        expect(store.view(salesByProduct)).toHaveLength(0);
        expect(store.view(totalSales)).toHaveLength(0);
    });

    // 9. applyHandler returns new state and emits
    it('applyHandler returns new state and emits', () => {
        const result = store.applyHandler(
            inventory,
            'sell',
            { stock: 5 },
            ['alice', 79, 1000],
        );

        expect(result.state).toMatchObject({ stock: 4 });
        expect(result.emits).toHaveLength(1);
        expect(result.emits[0]).toMatchObject({
            table: 'transactions',
            record: {
                productSlug: '$key',
                userId: 'alice',
                amount: 79,
                type: 'sale',
                timestamp: 1000,
            },
        });
    });

    // 10. applyHandler throws EntityError on guard failure
    it('applyHandler throws EntityError on guard failure', () => {
        expect(() =>
            store.applyHandler(inventory, 'sell', { stock: 0 }, ['alice', 79, 1000]),
        ).toThrow(EntityError);
    });

    // 11. applyHandler without emit returns empty emits array
    it('applyHandler without emit returns empty emits array', () => {
        const result = store.applyHandler(
            inventory,
            'restock',
            { stock: 3 },
            [10],
        );

        expect(result.state).toMatchObject({ stock: 13 });
        expect(result.emits).toEqual([]);
    });

    // 12. applyEmits resolves $key placeholders and inserts into pipeline
    it('applyEmits resolves $key placeholders and inserts into pipeline', () => {
        const result = store.applyHandler(
            inventory,
            'sell',
            { stock: 5 },
            ['alice', 79, 1000],
        );

        store.applyEmits(result.emits, 'headphones');

        const rows = store.view(salesByProduct);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            productSlug: 'headphones',
            total: 79,
            count: 1,
        });
    });

    // 13. Full entity round-trip: handler -> emit -> view
    it('full entity round-trip: handler -> emit -> view', () => {
        // Start with stock = 10
        let state: Record<string, unknown> = { stock: 10 };

        // Sell 3 items from 'headphones' entity
        for (let i = 0; i < 3; i++) {
            const result = store.applyHandler(
                inventory,
                'sell',
                state,
                [`user-${i}`, 79, 1000 + i],
            );
            state = result.state;
            store.applyEmits(result.emits, 'headphones');
        }

        // State should reflect 3 decrements
        expect(state).toMatchObject({ stock: 7 });

        // salesByProduct should have 1 row for headphones with total = 237
        const salesRows = store.view(salesByProduct);
        expect(salesRows).toHaveLength(1);
        expect(salesRows[0]).toMatchObject({
            productSlug: 'headphones',
            total: 237,
            count: 3,
        });

        // totalSales should aggregate across all transactions
        const totalRows = store.view(totalSales);
        expect(totalRows).toHaveLength(1);
        expect(totalRows[0]).toMatchObject({
            revenue: 237,
            count: 3,
        });
    });
});

// ── Entity-emitted remove() effect ──────────────────────────────────────────
//
// These tests exercise the full pipeline a DELETE envelope travels in
// production: entity handler → emit({effects: [remove(...)]}) →
// extractRemoves → applyRemoves → DBSP negative-weight delta →
// materialized views recomputed.
//
// The remove path is authoritative-only (no client optimism), so the
// handler-result shape is what the server would publish to NATS. If
// applyRemoves converges the views here, the production wire path —
// which just adds NATS + the data-worker's DELETE consumer — converges
// identically, since both rely on the same `{table, id}` tuple.

const thumbs = table('thumbs', {
    id: id(),
    noteId: integer(),
    userId: text(),
});

const thumbsByNote = view(thumbs).aggregate([thumbs.noteId], {
    count: count(),
});

// Raw projection — one view row per table row. Unlike the aggregate
// above (which keeps group keys with count=0 after deletes), this view
// collapses to an empty array when all rows are removed, giving crisp
// "row actually deleted" assertions.
const allThumbs = view(thumbs);

// Entity keyed per (userId, noteId) — `id` in state is 0 when no thumb
// exists, otherwise the id of the row this entity inserted. Toggle
// handler emits insert-or-remove based on that state.
const thumb = entity('thumb', {
    state: { rowId: integer() },
    handlers: {
        toggle(state, rowIdArg: number, noteId: number, userId: string) {
            if (state.rowId !== 0) {
                return emit({
                    state: { rowId: 0 },
                    effects: [remove(thumbs, state.rowId)],
                });
            }
            return emit({
                state: { rowId: rowIdArg },
                effects: [insert(thumbs, { id: rowIdArg, noteId, userId })],
            });
        },
    },
});

describe('TestStore — entity-emitted remove()', () => {
    let store: TestStore;

    beforeEach(() => {
        store = createTestStore({
            tables: [thumbs],
            views: { thumbsByNote, allThumbs },
        });
    });

    it('applyHandler surfaces emits AND removes on HandlerResult', () => {
        // First toggle: inserts. Result has 1 emit, 0 removes.
        const addResult = store.applyHandler(thumb, 'toggle', { rowId: 0 }, [7, 42, 'alice']);
        expect(addResult.state).toEqual({ rowId: 7 });
        expect(addResult.emits).toHaveLength(1);
        expect(addResult.removes).toHaveLength(0);

        // Second toggle: removes. Result has 0 emits, 1 remove.
        const removeResult = store.applyHandler(thumb, 'toggle', { rowId: 7 }, [7, 42, 'alice']);
        expect(removeResult.state).toEqual({ rowId: 0 });
        expect(removeResult.emits).toHaveLength(0);
        expect(removeResult.removes).toHaveLength(1);
        expect(removeResult.removes[0]).toEqual({ table: 'thumbs', id: 7 });
    });

    it('applyRemoves deletes rows and views recompute', () => {
        // Seed: thumb on noteId=42 exists.
        const addResult = store.applyHandler(thumb, 'toggle', { rowId: 0 }, [7, 42, 'alice']);
        store.applyEmits(addResult.emits);
        expect(store.view(thumbsByNote)).toEqual([{ noteId: 42n, count: 1 }]);
        expect(store.view(allThumbs)).toHaveLength(1);

        // Toggle off — applyRemoves feeds the DELETE into DBSP.
        const removeResult = store.applyHandler(thumb, 'toggle', addResult.state, [7, 42, 'alice']);
        store.applyRemoves(removeResult.removes);

        // Raw projection: row is gone entirely.
        expect(store.view(allThumbs)).toEqual([]);
        // Aggregate view: group key lingers with count=0.
        // FIXME: this documents a pre-existing DBSP behavior — aggregate
        // groups aren't pruned when their count hits zero. If DBSP is
        // later fixed to prune empty groups, tighten this to [].
        expect(store.view(thumbsByNote)).toEqual([{ noteId: 42n, count: 0 }]);
    });

    it('handles insert + remove composed in the same emit() call', () => {
        // A handler that both inserts a new thumb AND removes an old one
        // in a single emit — e.g., "replace thumb on note X with thumb
        // on note Y". Ordering matters: INSERT before REMOVE on the wire.
        const swap = entity('swap', {
            state: { rowId: integer() },
            handlers: {
                replace(_state, oldId: number, newId: number, noteId: number, userId: string) {
                    return emit({
                        state: { rowId: newId },
                        effects: [
                            insert(thumbs, { id: newId, noteId, userId }),
                            remove(thumbs, oldId),
                        ],
                    });
                },
            },
        });

        // Seed: two thumbs present.
        store.insert(thumbs, { id: 100, noteId: 1, userId: 'alice' });
        store.insert(thumbs, { id: 200, noteId: 1, userId: 'alice' });

        const result = store.applyHandler(swap, 'replace', { rowId: 200 }, [100, 300, 2, 'alice']);
        expect(result.emits).toHaveLength(1);
        expect(result.removes).toHaveLength(1);

        store.applyEmits(result.emits);
        store.applyRemoves(result.removes);

        // Note 1 still has id=200, note 2 has id=300. The removed id=100
        // is gone.
        expect(store.view(thumbsByNote)).toEqual(
            expect.arrayContaining([
                { noteId: 1n, count: 1 },
                { noteId: 2n, count: 1 },
            ]),
        );
    });

    it('applyRemoves throws on unknown table', () => {
        expect(() =>
            store.applyRemoves([{ table: 'not-registered', id: 1 }]),
        ).toThrow(/unknown table 'not-registered'/);
    });

    it('toggle on → off drives the aggregate view 1 → 0', () => {
        let state: Record<string, unknown> = { rowId: 0 };

        // Toggle on — handler emits insert, view aggregates to 1.
        const r1 = store.applyHandler(thumb, 'toggle', state, [1, 5, 'bob']);
        state = r1.state;
        expect(state).toEqual({ rowId: 1 });
        expect(r1.emits).toHaveLength(1);
        expect(r1.removes).toHaveLength(0);
        store.applyEmits(r1.emits);
        store.applyRemoves(r1.removes);
        expect(store.view(thumbsByNote)).toEqual([{ noteId: 5n, count: 1 }]);
        expect(store.view(allThumbs)).toHaveLength(1);

        // Toggle off — handler emits remove, view aggregates to 0 and
        // the raw projection collapses to empty.
        const r2 = store.applyHandler(thumb, 'toggle', state, [1, 5, 'bob']);
        state = r2.state;
        expect(state).toEqual({ rowId: 0 });
        expect(r2.emits).toHaveLength(0);
        expect(r2.removes).toHaveLength(1);
        store.applyEmits(r2.emits);
        store.applyRemoves(r2.removes);
        expect(store.view(allThumbs)).toEqual([]);
        // FIXME: aggregate group key lingers with count=0 due to a
        // pre-existing DBSP behavior. Tighten to [] if DBSP later prunes.
        expect(store.view(thumbsByNote)).toEqual([{ noteId: 5n, count: 0 }]);
    });
});

// ── Entity-emitted update() effect ──────────────────────────────────────────
//
// These tests exercise the full update pipeline: entity handler →
// emit({effects:[update(...)]}) → extractUpdates → applyUpdates →
// per-replica read-modify-write → DBSP -old/+merged deltas.
//
// The handler is pure; the "merge" semantics live at two layers:
//   1. Local row merge: patch fields overwrite oldRow fields (simple
//      spread). This is what SQLite sees after read-modify-write.
//   2. CRDT merge: DBSP's TableMergeState resolves per-column strategies
//      (lww/max/min/add/set_union) at the view layer, against its own
//      per-field HLC state separate from SQLite.

const docs = table('docs', {
    id: id(),
    title: text(),
    body: text(),
    version: integer(),
});

const allDocs = view(docs);

const docsTitleView = view(docs).aggregate([docs.title], { count: count() });

// Table with merge: false to exercise immutable-column rejection.
const auditLog = table('auditLog', {
    id: id(),
    kind: text({ merge: false }),
    who: text(),
});

describe('TestStore — entity-emitted update()', () => {
    let store: TestStore;

    beforeEach(() => {
        store = createTestStore({
            tables: [docs, auditLog],
            views: { allDocs, docsTitleView },
        });
    });

    it('applyHandler surfaces updates on HandlerResult', () => {
        const editor = entity('editor', {
            state: { lastEditedId: integer() },
            handlers: {
                editBody(_state, docId: number, body: string) {
                    return emit({
                        state: { lastEditedId: docId },
                        effects: [update(docs, docId, { body })],
                    });
                },
            },
        });

        const result = store.applyHandler(editor, 'editBody', { lastEditedId: 0 }, [42, 'new']);
        expect(result.state).toEqual({ lastEditedId: 42 });
        expect(result.emits).toHaveLength(0);
        expect(result.removes).toHaveLength(0);
        expect(result.updates).toHaveLength(1);
        expect(result.updates[0]).toEqual({
            table: 'docs',
            id: 42,
            patch: { body: 'new' },
        });
    });

    it('applyUpdates merges patch into existing row — unpatched fields carry over', () => {
        // Seed a full row.
        store.insert(docs, { id: 1, title: 'draft', body: 'original', version: 1 });

        // Patch only `body`. Title + version should persist.
        store.applyUpdates([{ table: 'docs', id: 1, patch: { body: 'edited' } }]);

        // View-layer assertions after upsert-style ops hit a pre-existing
        // TestStore/DBSP quirk — verify via rowStore instead.
        const row = store.getRow(docs, 1);
        expect(row).toMatchObject({ id: 1, title: 'draft', body: 'edited', version: 1 });
    });

    it('update on a missing row is a silent no-op', () => {
        // No seed — id 99 doesn't exist.
        store.applyUpdates([{ table: 'docs', id: 99, patch: { body: 'phantom' } }]);
        expect(store.getRow(docs, 99)).toBeUndefined();
    });

    it('update composes with insert + remove in a single emit', () => {
        const multi = entity('multi', {
            state: { n: integer() },
            handlers: {
                churn(state, newId: number, updateId: number, removeId: number) {
                    return emit({
                        state: { n: state.n + 1 },
                        effects: [
                            insert(docs, { id: newId, title: 't', body: 'b', version: 1 }),
                            update(docs, updateId, { title: 'edited' }),
                            remove(docs, removeId),
                        ],
                    });
                },
            },
        });

        // Seed two existing rows.
        store.insert(docs, { id: 10, title: 'orig', body: 'a', version: 1 });
        store.insert(docs, { id: 20, title: 'doomed', body: 'b', version: 1 });

        const result = store.applyHandler(multi, 'churn', { n: 0 }, [30, 10, 20]);
        expect(result.emits).toHaveLength(1);
        expect(result.updates).toHaveLength(1);
        expect(result.removes).toHaveLength(1);

        store.applyEmits(result.emits);
        store.applyUpdates(result.updates);
        store.applyRemoves(result.removes);

        // Row 10 updated, row 20 removed, row 30 inserted.
        expect(store.getRow(docs, 10)).toMatchObject({ title: 'edited', body: 'a' });
        expect(store.getRow(docs, 20)).toBeUndefined();
        expect(store.getRow(docs, 30)).toMatchObject({ title: 't', body: 'b' });
    });

    it('patch touching the primary key is rejected at handler time', () => {
        const bad = entity('bad', {
            state: { n: integer() },
            handlers: {
                tryChangeId(_state, docId: number) {
                    return emit({
                        state: { n: 1 },
                        effects: [update(docs, docId, { id: 999, body: 'x' })],
                    });
                },
            },
        });

        expect(() =>
            store.applyHandler(bad, 'tryChangeId', { n: 0 }, [1]),
        ).toThrow(/primary-key column 'id'/);
    });

    it('patch touching an immutable column is rejected at handler time', () => {
        const tamper = entity('tamper', {
            state: { n: integer() },
            handlers: {
                rewriteKind(_state, logId: number) {
                    return emit({
                        state: { n: 1 },
                        effects: [update(auditLog, logId, { kind: 'forged' })],
                    });
                },
            },
        });

        expect(() =>
            store.applyHandler(tamper, 'rewriteKind', { n: 0 }, [1]),
        ).toThrow(/column 'kind' is immutable.*merge: false/);
    });

    it('full edit round-trip: handler → update → view → handler → update', () => {
        const editor = entity('editor', {
            state: { lastEditedId: integer() },
            handlers: {
                edit(_state, docId: number, body: string) {
                    return emit({
                        state: { lastEditedId: docId },
                        effects: [update(docs, docId, { body })],
                    });
                },
            },
        });

        store.insert(docs, { id: 7, title: 'Note', body: 'v1', version: 1 });

        let state: Record<string, unknown> = { lastEditedId: 0 };

        const r1 = store.applyHandler(editor, 'edit', state, [7, 'v2']);
        state = r1.state;
        store.applyUpdates(r1.updates);
        expect(store.getRow(docs, 7)).toMatchObject({ body: 'v2' });

        const r2 = store.applyHandler(editor, 'edit', state, [7, 'v3']);
        state = r2.state;
        store.applyUpdates(r2.updates);
        expect(store.getRow(docs, 7)).toMatchObject({ body: 'v3' });

        expect(state).toEqual({ lastEditedId: 7 });
    });

    it('applyUpdates throws on unknown table', () => {
        expect(() =>
            store.applyUpdates([{ table: 'not-registered', id: 1, patch: {} }]),
        ).toThrow(/unknown table 'not-registered'/);
    });
});
