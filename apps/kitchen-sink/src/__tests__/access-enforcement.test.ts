import { describe, it, expect } from 'vitest';
import { createTestStore } from '@syncengine/test-utils';
import {
    Access,
    AccessDeniedError,
    defineEntity,
    integer,
    text,
} from '@syncengine/core';
import { transactions, salesByProduct } from '../schema';

// End-to-end smoke: an entity with an $access block, driven through the
// test store. Verifies that the full auth surface (Access DSL → entity
// config → applyHandler enforcement → AccessDeniedError propagation)
// works in a realistic application context with real tables and views.

const guardedInventory = defineEntity('guardedInventory', {
    state: {
        stock: integer(),
        ownerId: text(),
    },
    access: {
        restock: Access.role('admin'),
        sell: Access.authenticated,
        adjust: Access.owner('ownerId'),
    },
    handlers: {
        restock(state, amount: number) {
            return { ...state, stock: state.stock + amount };
        },
        sell(state) {
            return { ...state, stock: state.stock - 1 };
        },
        adjust(state, amount: number) {
            return { ...state, stock: state.stock + amount };
        },
    },
});

describe('end-to-end access enforcement', () => {
    it('allows an admin to restock', () => {
        const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
        const result = t.applyHandler(
            guardedInventory,
            'restock',
            { stock: 5, ownerId: 'alice' },
            [10],
            { user: { id: 'u1', roles: ['admin'] }, key: 'keyboard' },
        );
        expect(result.state.stock).toBe(15);
    });

    it('rejects a viewer trying to restock', () => {
        const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
        expect(() =>
            t.applyHandler(
                guardedInventory,
                'restock',
                { stock: 5, ownerId: 'alice' },
                [10],
                { user: { id: 'u1', roles: ['viewer'] }, key: 'keyboard' },
            ),
        ).toThrow(AccessDeniedError);
    });

    it('allows any authenticated user to sell', () => {
        const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
        const result = t.applyHandler(
            guardedInventory,
            'sell',
            { stock: 5, ownerId: 'alice' },
            [],
            { user: { id: 'anyone' }, key: 'keyboard' },
        );
        expect(result.state.stock).toBe(4);
    });

    it('rejects unauthenticated users from selling', () => {
        const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
        expect(() =>
            t.applyHandler(
                guardedInventory,
                'sell',
                { stock: 5, ownerId: 'alice' },
                [],
                { user: null, key: 'keyboard' },
            ),
        ).toThrow(AccessDeniedError);
    });

    it('owner check uses the configured state field', () => {
        const t = createTestStore({ tables: [transactions], views: { salesByProduct } });

        // Alice owns it — adjust succeeds
        const ok = t.applyHandler(
            guardedInventory,
            'adjust',
            { stock: 5, ownerId: 'alice' },
            [3],
            { user: { id: 'alice' }, key: 'keyboard' },
        );
        expect(ok.state.stock).toBe(8);

        // Bob doesn't own it — adjust denied
        expect(() =>
            t.applyHandler(
                guardedInventory,
                'adjust',
                { stock: 5, ownerId: 'alice' },
                [3],
                { user: { id: 'bob' }, key: 'keyboard' },
            ),
        ).toThrow(AccessDeniedError);
    });

    it('legacy callers without auth context skip enforcement entirely', () => {
        // Existing tests that don't pass auth continue to work — critical
        // for backward compatibility with pre-Plan-2 test suites.
        const t = createTestStore({ tables: [transactions], views: { salesByProduct } });
        const result = t.applyHandler(
            guardedInventory,
            'restock',
            { stock: 5, ownerId: 'alice' },
            [10],
        );
        expect(result.state.stock).toBe(15);
    });
});
