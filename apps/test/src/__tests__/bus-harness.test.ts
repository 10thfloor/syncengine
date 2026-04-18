// Demo: bus-aware tests that don't need Docker or a running NATS.
//
// The test harness (from `@syncengine/server/test`) swaps the publisher
// seam so both `publish()` effects (declarative, from entity handlers)
// and `bus.publish(ctx, payload)` (imperative, from workflow bodies)
// land in an in-process buffer. Vitest assertions run inline.
//
// Slice 2b-C1 only captures — subscriber workflows aren't dispatched
// yet. Slice 2b-C2 wires that up so `harness.dispatchedFor(shipOnPay)`
// becomes testable.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusTestHarness, type BusTestHarness } from '@syncengine/server/test';
import { orderEvents, OrderEvent } from '../events/orders.bus';
import { order } from '../entities/order.actor';

describe('bus test harness — apps/test demo', () => {
    let harness: BusTestHarness;

    beforeEach(() => {
        harness = createBusTestHarness();
    });

    afterEach(() => {
        harness.dispose();
    });

    it('entity.pay() attaches a publish() effect to its return', () => {
        const base = {
            status: 'placed' as const,
            productSlug: 'widget',
            userId: 'alice',
            price: 10,
            total: 10,
            customerEmail: '',
            createdAt: 0,
        };
        const result = order.$handlers.pay(base, { orderId: 'O1', at: 0 });

        // The returned state is the new state — status transitioned.
        expect(result).toMatchObject({ status: 'paid' });

        // The publish() effect rides along on a hidden Symbol key.
        const published = harness.capturePublishEffects(result);
        expect(published).toHaveLength(1);
        expect(published[0]).toMatchObject({
            bus: 'orderEvents',
            payload: {
                orderId: 'O1',
                event: OrderEvent.enum.paid,
                total: 10,
                at: 0,
            },
        });
    });

    it('imperative orderEvents.publish(ctx, ...) lands in publishedOn(orderEvents)', async () => {
        await orderEvents.publish(harness.ctx(), {
            orderId: 'O9',
            event: OrderEvent.enum.shipped,
            total: 42,
            at: 1000,
        });

        const events = harness.publishedOn(orderEvents);
        expect(events).toHaveLength(1);
        expect(events[0]!.event).toBe(OrderEvent.enum.shipped);
        expect(events[0]!.orderId).toBe('O9');
    });

    it('each test starts with an empty buffer', async () => {
        expect(harness.all()).toEqual([]);
        await orderEvents.publish(harness.ctx(), {
            orderId: 'X',
            event: OrderEvent.enum.placed,
            total: 1,
            at: 0,
        });
        expect(harness.all()).toHaveLength(1);
    });
});
