// Kitchen-sink demo: value objects land end-to-end across entity state,
// table inserts, and bus payloads. Runs against the in-process bus
// harness — no NATS, no Docker, full shape + invariant + brand
// preservation at every hop.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
    defineEntity,
    bus,
    emit,
    insert,
    publish,
    table,
    id,
    text,
    integer,
    buildInitialState,
    validateEntityState,
    applyHandler,
    op,
    withArgs,
} from '@syncengine/core';
import { defineWorkflow, on } from '@syncengine/server';
import {
    createBusTestHarness,
    type BusTestHarness,
} from '@syncengine/server/test';

import { Money } from '../values/money';
import { Email, UserId, OrderId } from '../values/ids';

// ── Schema — entity + table + bus, each uses value-object columns ──────────

const lineItems = table('vo_lineItems', {
    id: id(),
    orderId: OrderId(),
    price: Money(),
    label: text(),
});

const paymentEvents = bus('vo_paymentEvents', {
    schema: z.object({
        orderId: OrderId.zod,
        total: Money.zod,
        customerEmail: Email.zod,
        at: z.number(),
    }),
});

const orderAgg = defineEntity('vo_order', {
    state: {
        status: text({ enum: ['draft', 'paid'] as const }),
        total: Money({ default: Money.create.usd(0) }),
        customerEmail: Email({ nullable: true }),
        userId: UserId({ nullable: true }),
        count: integer(),
    },
    transitions: {
        draft: ['paid'],
        paid: [],
    },
    handlers: {
        addItem(state, price: ReturnType<typeof Money.create.usd>, label: string) {
            // Partial return — omitting `status` keeps the transition
            // graph untouched for this handler.
            return emit({
                state: {
                    total: Money.ops.add(state.total, price),
                    count: state.count + 1,
                } as never,
                effects: [
                    insert(lineItems, {
                        id: 0,
                        orderId: OrderId.unsafe('O1'),
                        price,
                        label,
                    }),
                ],
            });
        },
        pay(state, email: ReturnType<typeof Email.create.from>) {
            return emit({
                state: { status: 'paid' as const, customerEmail: email } as never,
                effects: [
                    publish(paymentEvents, {
                        orderId: OrderId.unsafe('O1'),
                        total: state.total,
                        customerEmail: email,
                        at: 0,
                    }),
                ],
            });
        },
    },
});

// ── Demo ───────────────────────────────────────────────────────────────────

describe('value objects — kitchen sink (entity + table + bus)', () => {
    let harness: BusTestHarness;
    let saw: { orderId: string; total: ReturnType<typeof Money.create.usd>; email: string }[];

    const alertOnPaid = defineWorkflow(
        'captureVoPaid',
        { on: on(paymentEvents) },
        async (_ctx, event) => {
            saw.push({
                orderId: event.orderId,
                total: event.total,
                email: event.customerEmail,
            });
        },
    );

    beforeEach(() => {
        saw = [];
        harness = createBusTestHarness({
            workflows: [alertOnPaid as never],
        });
    });
    afterEach(() => harness.dispose());

    it('entity initial state picks up Money default', () => {
        const s = buildInitialState(orderAgg.$state);
        expect(Money.is(s.total)).toBe(true);
        expect(s.total.amount).toBe(0);
    });

    it('addItem composes Money.ops.add + emits a typed table insert', () => {
        const s0 = buildInitialState(orderAgg.$state);
        const s1 = applyHandler(orderAgg, 'addItem', s0, [Money.create.usd(1999), 'widget']) as typeof s0;
        expect(Money.is(s1.total)).toBe(true);
        expect(s1.total.amount).toBe(1999);
        expect(s1.count).toBe(1);
    });

    it('pay publishes a Money-typed payload through the bus — subscriber receives it', async () => {
        const s0 = buildInitialState(orderAgg.$state);
        const s1 = applyHandler(orderAgg, 'addItem', s0, [Money.create.usd(2500), 'widget']) as typeof s0;
        const s2 = applyHandler(orderAgg, 'pay', s1, [Email.create.from('Alice@Example.COM')]) as typeof s1;

        expect(s2.status).toBe('paid');
        expect(s2.customerEmail).toBe('alice@example.com');

        await harness.driveEffects(s2);

        expect(saw).toHaveLength(1);
        expect(Money.is(saw[0]!.total)).toBe(true);
        expect(saw[0]!.total.amount).toBe(2500);
        expect(saw[0]!.email).toBe('alice@example.com');
    });

    it('bus schema rejects invalid payloads at publish time', async () => {
        // Money invariant fails (negative) — zod.parse throws before
        // the subscriber sees anything.
        await expect(
            paymentEvents.publish(harness.ctx(), {
                orderId: OrderId.unsafe('O1'),
                total: { amount: -1, currency: 'USD' } as never,
                customerEmail: Email.unsafe('a@b.com'),
                at: 0,
            }),
        ).rejects.toThrow(/invalid bus payload/);
        expect(saw).toHaveLength(0);
    });

    it('validateEntityState on JSON-arrived state rebrands all value columns', () => {
        // Simulates what happens after state round-trips through NATS:
        // brand symbols are lost (JSON.stringify strips them); the
        // framework re-stamps on read.
        const jsonArrived: Record<string, unknown> = {
            status: 'paid',
            total: { amount: 100, currency: 'USD' }, // plain object
            customerEmail: 'alice@example.com',      // plain string
            userId: 'u-1',
            count: 1,
        };
        const validated = validateEntityState(orderAgg.$state, jsonArrived, 'vo_order');
        expect(Money.is(validated.total)).toBe(true);
        expect(Email.is(validated.customerEmail)).toBe(true);
    });
});

// ── Polish slice — op() + withArgs() demo ─────────────────────────────────

describe('value objects — op() + withArgs() polish', () => {
    it('op(Money, fn) rebrands a raw-shape return', () => {
        // Realistic kitchen-sink usage: a doubling op on Money defined
        // via op() so the framework validates + brands the result
        // without the user routing through `Money.ops.scale`.
        const double = op(Money, (m: ReturnType<typeof Money.create.usd>) => ({
            amount: m.amount * 2,
            currency: m.currency,
        }));
        const out = double(Money.create.usd(50));
        expect(Money.is(out)).toBe(true);
        expect(out.amount).toBe(100);
    });

    it('withArgs validates value-def args at the handler boundary', () => {
        type S = { total: ReturnType<typeof Money.create.usd> };

        const pay = withArgs(
            [Money, Email] as const,
            (state: S, price, email) => ({
                total: Money.ops.add(state.total, price),
                customerEmail: email,
            }),
        );

        const s0: S = { total: Money.create.usd(0) };
        const s1 = pay(
            s0,
            { amount: 100, currency: 'USD' } as never,        // plain-JSON inbound
            'alice@example.com' as never,                     // plain string inbound
        );
        expect(Money.is(s1.total)).toBe(true);
        expect(s1.total.amount).toBe(100);
        expect(Email.is(s1.customerEmail)).toBe(true);
    });

    it('withArgs rejects an invalid Email at the boundary', () => {
        type S = object;
        const h = withArgs([Email] as const, (_state: S, email) => ({ email }));
        expect(() => h({}, 'not-an-email' as never)).toThrow(/rejected/);
    });
});
