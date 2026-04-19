import { describe, it, expect } from 'vitest';
import { entity, integer, text, Access, applyHandler, AccessDeniedError } from '../index';

describe('entity() access config', () => {
    it('accepts an access block alongside handlers', () => {
        const inventory = entity('inventory', {
            state: { stock: integer() },
            access: {
                restock: Access.deny,
                '*': Access.authenticated,
            },
            handlers: {
                restock(state) { return state; },
            },
        });
        expect(inventory.$access).toBeDefined();
        expect(inventory.$access?.restock).toBe(Access.deny);
        expect(inventory.$access?.['*']).toBe(Access.authenticated);
    });

    it('defaults $access to null when omitted', () => {
        const plain = entity('plain', {
            state: { count: integer() },
            handlers: {
                inc(state) { return state; },
            },
        });
        expect(plain.$access).toBeNull();
    });

    it('rejects an access entry that names a non-existent handler', () => {
        expect(() =>
            entity('bad', {
                state: { n: integer() },
                access: {
                    typo: Access.deny,
                },
                handlers: {
                    real(state) { return state; },
                },
            }),
        ).toThrow(/access key 'typo' does not match any handler/);
    });

    it('allows the wildcard "*" as a default', () => {
        const example = entity('example', {
            state: { count: integer() },
            access: {
                '*': Access.deny,
            },
            handlers: {
                something(state) { return state; },
            },
        });
        expect(example.$access?.['*']).toBe(Access.deny);
    });

    it('preserves text() state columns alongside the access block', () => {
        const orders = entity('orders', {
            state: { userId: text(), total: integer() },
            access: { cancel: Access.owner() },
            handlers: {
                cancel(state) { return { ...state, total: 0 }; },
            },
        });
        expect(orders.$access?.cancel.$kind).toBe('access');
    });
});

describe('applyHandler access enforcement', () => {
    const inventory = entity('inventory', {
        state: { stock: integer() },
        access: {
            restock: Access.role('admin'),
            sell: Access.authenticated,
            '*': Access.deny,
        },
        handlers: {
            restock(state, amount: number) { return { ...state, stock: state.stock + amount }; },
            sell(state) { return { ...state, stock: state.stock - 1 }; },
            inspect(state) { return state; },
        },
    });

    it('allows a handler when the policy passes', () => {
        const result = applyHandler(
            inventory,
            'restock',
            { stock: 5 },
            [3],
            { user: { id: 'u1', roles: ['admin'] }, key: 'keyboard' },
        );
        expect(result.stock).toBe(8);
    });

    it('throws AccessDeniedError when the policy rejects', () => {
        expect(() =>
            applyHandler(
                inventory,
                'restock',
                { stock: 5 },
                [3],
                { user: { id: 'u1', roles: ['viewer'] }, key: 'keyboard' },
            ),
        ).toThrow(AccessDeniedError);
    });

    it('falls back to the "*" policy when no handler-specific rule exists', () => {
        expect(() =>
            applyHandler(
                inventory,
                'inspect',
                { stock: 5 },
                [],
                { user: { id: 'u1', roles: ['admin'] }, key: 'keyboard' },
            ),
        ).toThrow(AccessDeniedError);
    });

    it('passes the current state to the policy for ownership checks', () => {
        const orders = entity('orders', {
            state: { userId: text(), total: integer() },
            access: {
                cancel: Access.owner(),
            },
            handlers: {
                cancel(state) { return { ...state, total: 0 }; },
            },
        });
        const aliceState = { userId: 'alice', total: 100 };
        expect(() =>
            applyHandler(
                orders,
                'cancel',
                aliceState,
                [],
                { user: { id: 'bob' }, key: 'order-1' },
            ),
        ).toThrow(AccessDeniedError);
        const ok = applyHandler(
            orders,
            'cancel',
            aliceState,
            [],
            { user: { id: 'alice' }, key: 'order-1' },
        );
        expect(ok.total).toBe(0);
    });

    it('skips enforcement entirely when auth context is undefined', () => {
        // Legacy call path — no auth info, no enforcement. Matches pre-Plan-2 behavior.
        const result = applyHandler(inventory, 'restock', { stock: 5 }, [3]);
        expect((result as { stock: number }).stock).toBe(8);
    });

    it('$system user bypasses all access policies', () => {
        // Gap 2 — workflow-initiated calls pass user.id = '$system'.
        // Even Access.deny on the handler lets these through.
        const denyAll = entity('denyAll', {
            state: { n: integer() },
            access: {
                '*': Access.deny,
            },
            handlers: {
                inc(state) { return { ...state, n: state.n + 1 }; },
            },
        });
        const result = applyHandler(
            denyAll,
            'inc',
            { n: 5 },
            [],
            { user: { id: '$system', roles: [] }, key: 'k' },
        );
        expect(result.n).toBe(6);
    });

    it('error context carries entity, handler, userId, and key', () => {
        try {
            applyHandler(
                inventory,
                'restock',
                { stock: 5 },
                [3],
                { user: { id: 'bob', roles: ['viewer'] }, key: 'keyboard' },
            );
            throw new Error('should have thrown');
        } catch (err) {
            if (!(err instanceof AccessDeniedError)) throw err;
            expect(err.context?.entity).toBe('inventory');
            expect(err.context?.handler).toBe('restock');
            expect(err.context?.userId).toBe('bob');
            expect(err.context?.key).toBe('keyboard');
        }
    });
});
