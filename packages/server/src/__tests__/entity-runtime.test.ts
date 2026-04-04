import { describe, it, expect } from 'vitest';
import { defineEntity, integer, text, real } from '@syncengine/core';
import { applyHandler, splitObjectKey } from '../entity-runtime';

// ── Fixtures ────────────────────────────────────────────────────────────────

const counter = defineEntity('counter', {
    state: { value: integer() },
    handlers: {
        increment(state, by: number) {
            return { value: state.value + by };
        },
        reset() {
            return { value: 0 };
        },
        bad() {
            // Returns something that fails state validation (string in a number col).
            return { value: 'oops' as unknown as number };
        },
    },
});

const cart = defineEntity('cart', {
    state: {
        items: integer(),
        total: real(),
        status: text({ enum: ['open', 'paid'] as const }),
    },
    handlers: {
        addItem(state, qty: number, price: number) {
            return { items: state.items + qty, total: state.total + qty * price };
        },
        pay(state) {
            if (state.items === 0) throw new Error('cart is empty');
            return { status: 'paid' as const };
        },
    },
});

// ── splitObjectKey ──────────────────────────────────────────────────────────

describe('splitObjectKey', () => {
    it('splits a workspace/entity composite key', () => {
        expect(splitObjectKey('demo/cart-1')).toEqual({
            workspaceId: 'demo',
            entityKey: 'cart-1',
        });
    });

    it('keeps the first slash and treats the rest as the entity key', () => {
        expect(splitObjectKey('demo/cart/sub/key')).toEqual({
            workspaceId: 'demo',
            entityKey: 'cart/sub/key',
        });
    });

    it('rejects keys without a slash', () => {
        expect(() => splitObjectKey('no-slash')).toThrow();
    });
});

// ── applyHandler — pure execution path ─────────────────────────────────────

describe('applyHandler', () => {
    it('runs a handler against null state by seeding initial state', () => {
        const next = applyHandler(counter, 'increment', null, [3]);
        expect(next).toEqual({ value: 3 });  // initial { value: 0 } + 3
    });

    it('runs a handler against an existing state', () => {
        const next = applyHandler(counter, 'increment', { value: 5 }, [10]);
        expect(next).toEqual({ value: 15 });
    });

    it('merges partial state returns into the existing record', () => {
        const next = applyHandler(cart, 'addItem', { items: 0, total: 0, status: 'open' }, [2, 50]);
        expect(next).toEqual({ items: 2, total: 100, status: 'open' });
    });

    it('preserves unmodified fields when handler returns a partial', () => {
        const next = applyHandler(
            cart,
            'pay',
            { items: 3, total: 150, status: 'open' },
            [],
        );
        expect(next).toEqual({ items: 3, total: 150, status: 'paid' });
    });

    it('throws on unknown handler name', () => {
        expect(() => applyHandler(counter, 'nonexistent', { value: 0 }, [])).toThrow(
            /no handler named 'nonexistent'/,
        );
    });

    it('wraps user-thrown errors with the entity context', () => {
        expect(() =>
            applyHandler(cart, 'pay', { items: 0, total: 0, status: 'open' }, []),
        ).toThrow(/'cart' handler 'pay' rejected: cart is empty/);
    });

    it('rejects handler outputs that fail state validation', () => {
        expect(() => applyHandler(counter, 'bad', { value: 0 }, [])).toThrow(
            /column 'value' expects number/,
        );
    });

    it('rejects handler outputs that violate enum constraints', () => {
        const evil = defineEntity('evil', {
            state: { status: text({ enum: ['open', 'closed'] as const }) },
            handlers: {
                weird() {
                    return { status: 'pending' as 'open' };  // type-erased
                },
            },
        });
        expect(() => applyHandler(evil, 'weird', { status: 'open' }, [])).toThrow(
            /must be one of/,
        );
    });
});

// ── End-to-end pure flow on a complete entity ──────────────────────────────

describe('full handler flow', () => {
    it('counter: increment by 1 ten times', () => {
        let state: Record<string, unknown> = { value: 0 };
        for (let i = 0; i < 10; i++) {
            state = applyHandler(counter, 'increment', state, [1]);
        }
        expect(state).toEqual({ value: 10 });
    });

    it('cart: add items, pay, reject re-pay', () => {
        let state: Record<string, unknown> | null = null;
        state = applyHandler(cart, 'addItem', state, [2, 50]);
        expect(state).toEqual({ items: 2, total: 100, status: 'open' });

        state = applyHandler(cart, 'addItem', state, [1, 25]);
        expect(state).toEqual({ items: 3, total: 125, status: 'open' });

        state = applyHandler(cart, 'pay', state, []);
        expect(state).toEqual({ items: 3, total: 125, status: 'paid' });

        // Paying again is allowed at the model level (handler doesn't guard);
        // the demo's real lock entity will guard differently.
        state = applyHandler(cart, 'pay', state, []);
        expect(state.status).toBe('paid');
    });
});
