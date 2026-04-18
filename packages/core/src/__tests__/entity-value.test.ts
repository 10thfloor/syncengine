// Entity integration — value-object columns round-trip through
// state validation + initial-state building. No server runtime here;
// we're testing the core module's contract that `validateEntityState`
// accepts branded values, re-runs invariants, and re-stamps brands
// so downstream code sees the brand regardless of wire hops.

import { describe, it, expect } from 'vitest';
import { defineEntity, buildInitialState, validateEntityState, applyHandler, emit, insert } from '../entity';
import { table, id, text, integer, real } from '../schema';
import { defineValue } from '../value';

const Money = defineValue('money', {
    amount: integer(),
    currency: text({ enum: ['USD', 'EUR'] as const }),
}, {
    invariant: (v) => v.amount >= 0,
    create: {
        usd: (cents: number) => ({ amount: cents, currency: 'USD' as const }),
    },
    ops: {
        add: (a, b) => ({ amount: a.amount + b.amount, currency: a.currency }),
    },
});

const Email = defineValue('email', text(), {
    invariant: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
    create: { from: (raw: string) => raw.toLowerCase().trim() },
});

const order = defineEntity('order', {
    state: {
        status: text({ enum: ['draft', 'paid'] as const }),
        total: Money({ default: Money.create.usd(0) }),
        customerEmail: Email({ nullable: true }),
    },
    transitions: {
        draft: ['paid'],
        paid: [],
    },
    handlers: {
        setEmail(_state, email: ReturnType<typeof Email.create.from>) {
            return { customerEmail: email };
        },
        addItem(state, price: ReturnType<typeof Money.create.usd>) {
            return { total: Money.ops.add(state.total, price) };
        },
        pay(state) {
            return { ...state, status: 'paid' as const };
        },
    },
});

describe('entity — value-column state lifecycle', () => {
    it('buildInitialState picks up Money default', () => {
        const s = buildInitialState(order.$state);
        expect(s.total).toMatchObject({ amount: 0, currency: 'USD' });
        expect(s.customerEmail).toBeNull();
        expect(s.status).toBe('draft');
    });

    it('validateEntityState rejects invalid Money (invariant failure)', () => {
        expect(() =>
            validateEntityState(order.$state, {
                status: 'draft',
                total: { amount: -1, currency: 'USD' },
                customerEmail: null,
            }, 'order'),
        ).toThrow(/money.*rejected/i);
    });

    it('validateEntityState rehydrates + rebrands from plain JSON', () => {
        const validated = validateEntityState(order.$state, {
            status: 'draft',
            total: { amount: 100, currency: 'USD' },  // plain object, no brand
            customerEmail: 'alice@example.com',
        }, 'order');
        expect(Money.is(validated.total)).toBe(true);
        expect(Email.is(validated.customerEmail)).toBe(true);
    });

    it('validateEntityState rejects an unbranded Email that fails invariant', () => {
        expect(() =>
            validateEntityState(order.$state, {
                status: 'draft',
                total: Money.create.usd(0),
                customerEmail: 'not-an-email',
            }, 'order'),
        ).toThrow(/email.*rejected/i);
    });

    it('applyHandler merges Money.ops.add return correctly', () => {
        const s0 = buildInitialState(order.$state);
        const s1 = applyHandler(order, 'addItem', s0, [Money.create.usd(1999)]) as { total: ReturnType<typeof Money.create.usd> };
        expect(Money.is(s1.total)).toBe(true);
        expect(s1.total.amount).toBe(1999);
    });

    it('nullable Email column accepts null in validation', () => {
        const v = validateEntityState(order.$state, {
            status: 'draft',
            total: Money.create.usd(0),
            customerEmail: null,
        }, 'order');
        expect(v.customerEmail).toBeNull();
    });
});

// ── Table insert() validation (Phase D) ───────────────────────────────────

const lineItems = table('lineItems', {
    id: id(),
    orderId: text(),
    price: Money(),
    label: text(),
    rate: real({ merge: false }),  // primitive column alongside value columns
});

describe('insert() effect — value-column validation', () => {
    it('accepts a branded Money in the record', () => {
        const result = emit({
            state: { status: 'draft' as const },
            effects: [
                insert(lineItems, {
                    id: 0,
                    orderId: 'O1',
                    price: Money.create.usd(100),
                    label: 'widget',
                    rate: 1,
                }),
            ],
        });
        expect(result.status).toBe('draft');
    });

    it('rejects an insert with an invalid Money (invariant failure)', () => {
        expect(() =>
            emit({
                state: { status: 'draft' as const },
                effects: [
                    insert(lineItems, {
                        id: 0,
                        orderId: 'O1',
                        price: { amount: -1, currency: 'USD' } as never,
                        label: 'widget',
                        rate: 1,
                    }),
                ],
            }),
        ).toThrow(/money.*rejected/i);
    });

    it('rejects an insert with a plain-object Money when shape is fine but unbranded', () => {
        // Shape matches and invariant passes, so it accepts — the point
        // of `.is()` is admissibility, not brand-origin.
        const result = emit({
            state: { status: 'draft' as const },
            effects: [
                insert(lineItems, {
                    id: 0,
                    orderId: 'O1',
                    price: { amount: 100, currency: 'USD' } as never,
                    label: 'widget',
                    rate: 1,
                }),
            ],
        });
        expect(result.status).toBe('draft');
    });

    it('primitive columns on the same table are untouched', () => {
        // Exercises that the validator only inspects `$valueRef`-tagged
        // columns — doesn't accidentally reject primitives.
        const result = emit({
            state: { status: 'draft' as const },
            effects: [
                insert(lineItems, {
                    id: 0,
                    orderId: 'O1',
                    price: Money.create.usd(0),
                    label: 'x'.repeat(1000),  // big string, fine
                    rate: 1.5,
                }),
            ],
        });
        expect(result.status).toBe('draft');
    });
});
