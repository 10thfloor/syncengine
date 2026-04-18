import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore, type TestStore } from '../index.js';
import {
    table, id, text, integer, real,
    view, sum, count, max,
    entity, emit, insert, EntityError,
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
