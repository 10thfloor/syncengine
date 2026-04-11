import { describe, it, expect } from 'vitest';
import { createTestStore } from '@syncengine/test-utils';
import {
    transactions, orderIndex,
    salesByProduct, totalSales, allOrders,
} from '../schema';

describe('View Pipelines', () => {
    it('salesByProduct aggregates by product slug', () => {
        const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
        t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
        t.insert(transactions, { productSlug: 'keyboard', userId: 'bob', amount: 79, type: 'sale', timestamp: 2 });
        t.insert(transactions, { productSlug: 'mouse', userId: 'alice', amount: 29, type: 'sale', timestamp: 3 });

        const rows = t.view(salesByProduct);
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.productSlug === 'keyboard')).toMatchObject({ total: 158, count: 2 });
        expect(rows.find((r) => r.productSlug === 'mouse')).toMatchObject({ total: 29, count: 1 });
    });

    it('totalSales computes net revenue including refunds', () => {
        const t = createTestStore({ tables: [transactions], views: { totalSales } });
        t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
        t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: -79, type: 'refund', timestamp: 2 });

        const totals = t.view(totalSales);
        expect(totals[0]).toMatchObject({ revenue: 0, count: 2 });
    });

    it('allOrders deduplicates by composite key', () => {
        const t = createTestStore({ tables: [orderIndex], views: { allOrders } });
        t.insert(orderIndex, { orderId: 'ord-1', productSlug: 'keyboard', userId: 'alice', price: 79, createdAt: 1 });
        t.insert(orderIndex, { orderId: 'ord-2', productSlug: 'mouse', userId: 'bob', price: 29, createdAt: 2 });
        expect(t.view(allOrders)).toHaveLength(2);
    });
});
