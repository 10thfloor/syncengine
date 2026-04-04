/**
 * PLAN Phase 5 — Typed RPC guarantees.
 *
 * PLAN.md Phase 5 originally called for a ts-morph codegen step to emit
 * handler parameter types into a client virtual module. That turned out
 * to be unnecessary: TypeScript already propagates handler signatures
 * end-to-end through `EntityDef<TName, TShape, THandlers>` generics.
 * When the user writes:
 *
 *     export const cart = defineEntity('cart', {
 *         state: { items: integer() },
 *         handlers: {
 *             addItem(state, qty: number, sku: string) { ... },
 *         },
 *     });
 *
 *     const { actions } = useEntity(cart, 'k');
 *     actions.addItem(3, 'sku-1');
 *
 * TSC reads the actor file's original source (Vite's runtime transform
 * has no effect on type checking), infers THandlers, maps through
 * `ActionMap<TState, THandlers>`, and produces a concrete function
 * type `(qty: number, sku: string) => Promise<State>` at the call site.
 * A wrong argument type is caught at compile time with a clear error.
 *
 * These tests lock that guarantee in place. Each `@ts-expect-error`
 * line documents a concrete property of the type flow — if any of them
 * stops being a type error, we've regressed and need to investigate.
 *
 * The tests use no runtime assertions beyond `expect(true).toBe(true)`
 * because the real checks happen in tsc during `pnpm -r typecheck`.
 */

import { describe, it, expect } from 'vitest';
import {
    defineEntity,
    integer,
    text,
    type EntityRecord,
} from '@syncengine/core';
import { useEntity, type ActionMap } from '../entity-client';

// ── Fixtures ────────────────────────────────────────────────────────────────

const counter = defineEntity('counter', {
    state: {
        value: integer(),
    },
    handlers: {
        increment(state, by: number) {
            return { value: state.value + by };
        },
        setLabel(state, label: string, version: number) {
            return { value: state.value, label, version };
        },
        reset() {
            return { value: 0 };
        },
    },
});

const cart = defineEntity('cart', {
    state: {
        items: integer(),
        total: integer(),
        status: text({ enum: ['open', 'paid'] as const }),
    },
    handlers: {
        addItem(state, qty: number, unitPrice: number) {
            return {
                items: state.items + qty,
                total: state.total + qty * unitPrice,
            };
        },
        pay(state) {
            if (state.items === 0) throw new Error('empty');
            return { status: 'paid' as const };
        },
    },
});

// ── Handler argument inference ─────────────────────────────────────────────

describe('useEntity action typing (PLAN Phase 5)', () => {
    it('action proxy carries the handler trailing-arg signature', () => {
        // Purely a compile-time check — we don't actually mount the hook.
        function _check() {
            const { actions } = useEntity(counter, 'global');

            // Valid: (by: number)
            actions.increment(5);
            // Valid: (label: string, version: number)
            actions.setLabel('main', 2);
            // Valid: no args
            actions.reset();

            // @ts-expect-error — wrong arg type (string passed where number expected)
            actions.increment('nope');
            // @ts-expect-error — too few args
            actions.setLabel('only-label');
            // @ts-expect-error — too many args
            actions.reset(1);
            // @ts-expect-error — unknown handler
            actions.doesNotExist();
        }
        void _check;
        expect(true).toBe(true);
    });

    it('multi-arg handlers preserve positional order and types', () => {
        function _check() {
            const { actions } = useEntity(cart, 'cart-1');

            // Valid: (qty: number, unitPrice: number)
            actions.addItem(2, 99);

            // @ts-expect-error — args reversed (string, number) vs (number, number)
            actions.addItem('two', 99);
            // @ts-expect-error — second arg wrong type
            actions.addItem(2, 'cheap');
            // @ts-expect-error — missing second arg
            actions.addItem(2);
        }
        void _check;
        expect(true).toBe(true);
    });

    it('action return type is Promise<State> not Promise<Partial<State>>', () => {
        async function _check() {
            const { actions } = useEntity(cart, 'cart-1');
            const state = await actions.addItem(1, 50);
            // Should be a full State record, not Partial
            const _items: number = state.items;
            const _total: number = state.total;
            const _status: 'open' | 'paid' = state.status;
            void _items;
            void _total;
            void _status;
        }
        void _check;
        expect(true).toBe(true);
    });

    it('rejecting wrong-typed state access on the hook return', () => {
        function _check() {
            const { state } = useEntity(cart, 'cart-1');
            if (state) {
                const _items: number = state.items;
                void _items;

                // @ts-expect-error — 'nonExistentField' is not in the state shape
                const _bad: unknown = state.nonExistentField;
                void _bad;
            }
        }
        void _check;
        expect(true).toBe(true);
    });

    it('EntityRecord<typeof entity> matches the hook state type', () => {
        type CartRecord = EntityRecord<typeof cart>;
        const sample: CartRecord = { items: 0, total: 0, status: 'open' };
        expect(sample.status).toBe('open');
    });

    it('ActionMap<State, Handlers> reshapes correctly for a standalone type use', () => {
        // Users can grab the ActionMap type directly to annotate props,
        // e.g., for components that receive an action proxy from a parent.
        type CartState = EntityRecord<typeof cart>;
        type CartActions = ActionMap<CartState, typeof cart.$handlers>;

        function _check() {
            const noop = (_: CartActions) => {};
            noop({
                addItem: async (_qty: number, _price: number) => ({
                    items: 0,
                    total: 0,
                    status: 'open' as const,
                }),
                pay: async () => ({ items: 0, total: 0, status: 'paid' as const }),
            });
        }
        void _check;
        expect(true).toBe(true);
    });
});
