import { describe, it, expect } from 'vitest';
import { createTestStore } from '@syncengine/test-utils';
import { SyncEngineError } from '@syncengine/core';
import { transactions, orderIndex, salesByProduct, allOrders } from '../schema';
import { inventory } from '../entities/inventory.actor';
import { order } from '../entities/order.actor';

describe('Entity Handlers', () => {
    describe('inventory', () => {
        it('sell decrements stock and emits transaction', () => {
            const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
            const result = t.applyHandler(inventory, 'sell',
                { stock: 10, reserved: 1, reservedBy: 'alice', reservedAt: 1 },
                ['alice', 'ord-1', 79, 100]);
            expect(result.state.stock).toBe(9);
            expect(result.emits).toHaveLength(1);

            t.applyEmits(result.emits, 'keyboard');
            expect(t.view(salesByProduct)[0]).toMatchObject({ productSlug: 'keyboard', total: 79 });
        });

        it('sell throws when not reserved', () => {
            const t = createTestStore({ tables: [transactions], views: {} });
            expect(() =>
                t.applyHandler(inventory, 'sell',
                    { stock: 10, reserved: 0, reservedBy: '', reservedAt: 0 },
                    ['alice', 'ord-1', 79, 100]),
            ).toThrow('reservation');
        });
    });

    describe('order', () => {
        it('place transitions to placed and emits to orderIndex', () => {
            const t = createTestStore({ tables: [orderIndex], views: { allOrders } });
            const result = t.applyHandler(order, 'place',
                { status: 'draft', productSlug: '', userId: '', price: 0, createdAt: 0 },
                ['alice', 'keyboard', 79, 1000]);
            expect(result.state.status).toBe('placed');

            t.applyEmits(result.emits, 'ord-123');
            expect(t.view(allOrders)).toHaveLength(1);
            expect(t.view(allOrders)[0]).toMatchObject({ orderId: 'ord-123', productSlug: 'keyboard' });
        });

        it('cancel from placed succeeds', () => {
            const result = createTestStore({ tables: [], views: {} }).applyHandler(order, 'cancel',
                { status: 'placed', productSlug: 'kb', userId: 'a', price: 79, createdAt: 1 }, []);
            expect(result.state.status).toBe('cancelled');
        });

        it('invalid transition throws SyncEngineError', () => {
            const t = createTestStore({ tables: [], views: {} });
            expect(() =>
                t.applyHandler(order, 'deliver',
                    { status: 'placed', productSlug: 'kb', userId: 'a', price: 79, createdAt: 1 }, []),
            ).toThrow(SyncEngineError);
        });
    });
});
