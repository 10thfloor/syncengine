import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { TerminalError } from '@restatedev/restate-sdk';
import { bus, entity, text, emit, publish, BusMode, override, isBusOverride, serviceOverride, service } from '@syncengine/core';
import { createBusTestHarness, type BusTestHarness } from '../test/bus-harness';
import { defineWorkflow, on } from '../index';

const schema = z.object({
    orderId: z.string(),
    total: z.number(),
});
const orderEvents = bus('orderEvents', { schema });

describe('createBusTestHarness', () => {
    let harness: BusTestHarness;

    beforeEach(() => {
        harness = createBusTestHarness();
    });
    afterEach(() => {
        harness.dispose();
    });

    it('captures imperative bus.publish(ctx, payload) calls', async () => {
        await orderEvents.publish(harness.ctx(), { orderId: 'O1', total: 10 });
        await orderEvents.publish(harness.ctx(), { orderId: 'O2', total: 42 });

        const events = harness.publishedOn(orderEvents);
        expect(events).toHaveLength(2);
        expect(events[0]).toEqual({ orderId: 'O1', total: 10 });
        expect(events[1]).toEqual({ orderId: 'O2', total: 42 });
    });

    it('rejects publish with schema-invalid payload', async () => {
        await expect(
            orderEvents.publish(harness.ctx(), { orderId: 'O3' } as never),
        ).rejects.toThrow(/invalid bus payload/);
    });

    it('clear() drains the buffer without re-installing the publisher', async () => {
        await orderEvents.publish(harness.ctx(), { orderId: 'O1', total: 10 });
        harness.clear();
        await orderEvents.publish(harness.ctx(), { orderId: 'O2', total: 20 });
        expect(harness.publishedOn(orderEvents)).toEqual([
            { orderId: 'O2', total: 20 },
        ]);
    });

    it('all() shows cross-bus chronology', async () => {
        const other = bus('otherEvents', { schema });
        await orderEvents.publish(harness.ctx(), { orderId: 'O1', total: 10 });
        await other.publish(harness.ctx(), { orderId: 'O2', total: 20 });
        const all = harness.all();
        expect(all.map((e) => e.bus)).toEqual(['orderEvents', 'otherEvents']);
    });

    describe('capturePublishEffects — declarative path', () => {
        const cart = entity('cart', {
            state: {
                status: text({ enum: ['open', 'paid'] as const }),
                total: text(),
            },
            transitions: {
                open: ['paid'],
                paid: [],
            },
            handlers: {
                pay(state, req: { orderId: string }) {
                    return emit({
                        state: { ...state, status: 'paid' as const },
                        effects: [
                            publish(orderEvents, { orderId: req.orderId, total: 99 }),
                        ],
                    });
                },
            },
        });

        it('pulls publish() effects off an entity handler return', () => {
            const result = cart.$handlers.pay(
                { status: 'open', total: '0' },
                { orderId: 'Z1' },
            );
            const captured = harness.capturePublishEffects(result);
            expect(captured).toHaveLength(1);
            expect(captured[0]).toMatchObject({
                bus: 'orderEvents',
                payload: { orderId: 'Z1', total: 99 },
            });
        });

        it('returns empty for a handler that published nothing', () => {
            const result = {
                status: 'open' as const,
                total: '0',
            };
            expect(harness.capturePublishEffects(result)).toEqual([]);
        });
    });
});

describe('BusMode + override(bus)', () => {
    it('BusMode.nats / .inMemory are tagged factories', () => {
        expect(BusMode.nats()).toEqual({ kind: 'nats' });
        expect(BusMode.inMemory()).toEqual({ kind: 'inMemory' });
    });

    it('bus() stores mode — defaults to nats, respects explicit inMemory', () => {
        const b1 = bus('b1', { schema });
        expect(b1.$mode).toEqual({ kind: 'nats' });

        const b2 = bus('b2', { schema, mode: BusMode.inMemory() });
        expect(b2.$mode).toEqual({ kind: 'inMemory' });
    });

    it('a bus DLQ inherits the parent mode', () => {
        const inMem = bus('inMem', { schema, mode: BusMode.inMemory() });
        expect(inMem.dlq.$mode).toEqual({ kind: 'inMemory' });
    });

    it('override(bus, { mode }) produces a BusOverride', () => {
        const ovr = override(orderEvents, { mode: BusMode.inMemory() });
        expect(isBusOverride(ovr)).toBe(true);
        expect(ovr.$tag).toBe('bus-override');
        expect(ovr.$targetName).toBe('orderEvents');
        expect(ovr.mode).toEqual({ kind: 'inMemory' });
    });

    it('override(service, {...}) still works — polymorphic dispatch', () => {
        const payments = service('payments', {
            async charge(_amount: number): Promise<{ id: string }> {
                return { id: 'ch_prod' };
            },
        });
        const ovr = override(payments, {
            async charge(_amount: number) {
                return { id: 'ch_test' };
            },
        });
        expect(ovr.$tag).toBe('service-override');
        expect(ovr.$targetName).toBe('payments');

        // serviceOverride (narrow form) is also exposed.
        const narrow = serviceOverride(payments, {
            async charge(_amount: number) {
                return { id: 'ch_narrow' };
            },
        });
        expect(narrow.$tag).toBe('service-override');
    });

    it('override() rejects non-ServiceDef, non-BusRef targets', () => {
        expect(() => override({ $tag: 'nope' } as never, { mode: BusMode.nats() })).toThrow(
            /ServiceDef or BusRef/,
        );
    });
});

// ── 2b-C2: synchronous subscriber dispatch ───────────────────────────────
describe('createBusTestHarness — subscriber dispatch', () => {
    const shipping = service('shipping', {
        async create(orderId: string): Promise<{ trackingId: string }> {
            if (orderId.startsWith('fail-')) {
                throw new Error(`boom on ${orderId}`);
            }
            return { trackingId: `trk_${orderId}` };
        },
    });

    const shipOnPay = defineWorkflow(
        'shipOnPay',
        {
            on: on(orderEvents).where((e) => e.total > 0),
            services: [shipping],
        },
        async (ctx, event) => {
            try {
                await ctx.services.shipping.create(event.orderId);
            } catch (err) {
                throw new TerminalError(`shipOnPay failed: ${(err as Error).message}`);
            }
        },
    );

    const alertOnDlq = defineWorkflow(
        'alertOnDlq',
        {
            on: on(orderEvents.dlq),
        },
        async (_ctx, _dead) => {
            // no-op; harness tracks via dispatched.
        },
    );

    let harness: BusTestHarness;

    beforeEach(() => {
        harness = createBusTestHarness({
            workflows: [shipOnPay, alertOnDlq] as never,
            services: [shipping],
        });
    });
    afterEach(() => {
        harness.dispose();
    });

    it('fires subscribers inline on imperative publish', async () => {
        await orderEvents.publish(harness.ctx(), { orderId: 'O1', total: 10 });
        const dispatched = harness.dispatchedFor(shipOnPay);
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]!.outcome).toBe('ok');
        expect(dispatched[0]!.payload).toMatchObject({ orderId: 'O1', total: 10 });
    });

    it('honours .where() — predicate rejects before dispatch', async () => {
        await orderEvents.publish(harness.ctx(), { orderId: 'O2', total: 0 });
        expect(harness.dispatchedFor(shipOnPay)).toHaveLength(0);
    });

    it('routes TerminalError to <bus>.dlq with a DeadEvent', async () => {
        await orderEvents.publish(harness.ctx(), { orderId: 'fail-O3', total: 5 });

        const shipEntries = harness.dispatchedFor(shipOnPay);
        expect(shipEntries).toHaveLength(1);
        expect(shipEntries[0]!.outcome).toBe('terminal-error');

        // The DLQ subscriber fired with a DeadEvent.
        const dlqEntries = harness.dispatchedFor(alertOnDlq);
        expect(dlqEntries).toHaveLength(1);
        const dead = dlqEntries[0]!.payload as {
            original: unknown;
            error: { message: string };
            workflow: string;
        };
        expect(dead.workflow).toBe('shipOnPay');
        expect(dead.original).toMatchObject({ orderId: 'fail-O3' });
        expect(dead.error.message).toMatch(/shipOnPay failed/);
    });

    it('resolves declared services on ctx.services — missing services throw', () => {
        const notificationsSvc = service('notifications', {
            async send() { /* noop */ },
        });
        const notifier = defineWorkflow(
            'notifier',
            {
                on: on(orderEvents),
                services: [notificationsSvc],
            },
            async (_ctx, _e) => { /* noop */ },
        );
        expect(() =>
            createBusTestHarness({ workflows: [notifier], services: [] }),
        ).toThrow(/Service 'notifications' not registered/);
    });

    it('driveEffects drains publish() effects from an entity return', async () => {
        const order = entity('order', {
            state: { status: text({ enum: ['open', 'paid'] as const }) },
            transitions: { open: ['paid'], paid: [] },
            handlers: {
                pay(state, req: { orderId: string }) {
                    return emit({
                        state: { ...state, status: 'paid' as const },
                        effects: [publish(orderEvents, { orderId: req.orderId, total: 100 })],
                    });
                },
            },
        });

        const result = order.$handlers.pay({ status: 'open' }, { orderId: 'D1' });
        await harness.driveEffects(result);

        expect(harness.publishedOn(orderEvents)).toHaveLength(1);
        expect(harness.dispatchedFor(shipOnPay)).toHaveLength(1);
    });

    it('non-terminal handler errors surface to the test author', async () => {
        const buggy = defineWorkflow(
            'buggy',
            { on: on(orderEvents) },
            async () => {
                throw new Error('unexpected bug');
            },
        );
        const h = createBusTestHarness({ workflows: [buggy] });
        await expect(
            orderEvents.publish(h.ctx(), { orderId: 'X', total: 1 }),
        ).rejects.toThrow(/unexpected bug/);
        h.dispose();
    });

    it('non-subscriber workflows in the list are ignored', async () => {
        const saga = defineWorkflow('saga', async () => { /* noop */ });
        // Should not throw even though `saga` has no $subscription.
        const h = createBusTestHarness({
            workflows: [shipOnPay, saga as never],
            services: [shipping],
        });
        await orderEvents.publish(h.ctx(), { orderId: 'Y', total: 1 });
        expect(h.dispatchedFor(shipOnPay)).toHaveLength(1);
        expect(h.dispatchedFor('saga')).toHaveLength(0);
        h.dispose();
    });
});
