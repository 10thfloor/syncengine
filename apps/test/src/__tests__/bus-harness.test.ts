// Kitchen-sink bus harness demo — tests without Docker.
//
// Both slices on display:
//   2b-C1 — capturing publisher: verify entity publishes and inspect
//           imperative bus.publish(ctx, ...) calls against a mock ctx.
//   2b-C2 — synchronous subscriber dispatch: the same subscriber
//           workflows the smoke runs (shipOnPay, alertOnShippingFailure)
//           fire inline when a matching event is published, with typed
//           ctx.services populated from the declared services tuple.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusTestHarness, type BusTestHarness } from '@syncengine/server/test';
import { orderEvents, OrderEvent } from '../events/orders.bus';
import { order } from '../entities/order.actor';
import { shipOnPay } from '../workflows/ship-on-pay.workflow';
import { alertOnShippingFailure } from '../workflows/alert-on-shipping-failure.workflow';
import { shipping } from '../services/shipping';
import { notifications } from '../services/notifications';

describe('bus test harness — capture only (2b-C1)', () => {
    let harness: BusTestHarness;

    beforeEach(() => { harness = createBusTestHarness(); });
    afterEach(() => { harness.dispose(); });

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

        expect(result).toMatchObject({ status: 'paid' });

        const published = harness.capturePublishEffects(result);
        expect(published).toHaveLength(1);
        expect(published[0]).toMatchObject({
            bus: 'orderEvents',
            payload: { orderId: 'O1', event: OrderEvent.enum.paid, total: 10, at: 0 },
        });
    });

    it('imperative orderEvents.publish(ctx, ...) lands in publishedOn', async () => {
        await orderEvents.publish(harness.ctx(), {
            orderId: 'O9', event: OrderEvent.enum.shipped, total: 42, at: 1000,
        });
        expect(harness.publishedOn(orderEvents)).toHaveLength(1);
    });
});

describe('bus test harness — subscriber dispatch (2b-C2)', () => {
    let harness: BusTestHarness;

    beforeEach(() => {
        harness = createBusTestHarness({
            workflows: [shipOnPay, alertOnShippingFailure] as never,
            services: [shipping, notifications],
        });
    });
    afterEach(() => { harness.dispose(); });

    it('shipOnPay fires on a paid event and calls shipping.create', async () => {
        await orderEvents.publish(harness.ctx(), {
            orderId: 'O1', event: OrderEvent.enum.paid, total: 10, at: 0,
        });

        const dispatched = harness.dispatchedFor(shipOnPay);
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]!.outcome).toBe('ok');
    });

    it('.where() predicate filters out non-paid events server-side', async () => {
        await orderEvents.publish(harness.ctx(), {
            orderId: 'O2', event: OrderEvent.enum.placed, total: 10, at: 0,
        });
        expect(harness.dispatchedFor(shipOnPay)).toHaveLength(0);
    });

    it('TerminalError routes through orderEvents.dlq to alertOnShippingFailure', async () => {
        await orderEvents.publish(harness.ctx(), {
            orderId: 'fail-O3', event: OrderEvent.enum.paid, total: 5, at: 0,
        });

        const shipEntries = harness.dispatchedFor(shipOnPay);
        expect(shipEntries).toHaveLength(1);
        expect(shipEntries[0]!.outcome).toBe('terminal-error');

        const alertEntries = harness.dispatchedFor(alertOnShippingFailure);
        expect(alertEntries).toHaveLength(1);
        const dead = alertEntries[0]!.payload as {
            workflow: string;
            original: { orderId: string };
        };
        expect(dead.workflow).toBe('shipOnPay');
        expect(dead.original.orderId).toBe('fail-O3');
    });

    it('driveEffects dispatches entity-published effects through subscribers', async () => {
        const base = {
            status: 'placed' as const,
            productSlug: 'widget',
            userId: 'alice',
            price: 10,
            total: 10,
            customerEmail: '',
            createdAt: 0,
        };
        const result = order.$handlers.pay(base, { orderId: 'O4', at: 0 });
        await harness.driveEffects(result);

        expect(harness.dispatchedFor(shipOnPay)).toHaveLength(1);
    });
});
