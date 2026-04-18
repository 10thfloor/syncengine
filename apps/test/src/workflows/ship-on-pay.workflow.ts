// ── shipOnPay Workflow ─────────────────────────────────────────────────────
//
// Subscriber workflow for the `orderEvents` bus. `.where` pushes the paid-
// event filter down to the JetStream consumer so we only invoke Restate
// for events that actually matter.
//
// Kitchen-sink demo for three features:
//   1. Typed `ctx.services.shipping` — inferred from the `services:` tuple
//      by `ServicesOf<T>` in @syncengine/core. No casts.
//   2. Per-subscriber retry override — tighter schedule than the bus's
//      default (2 attempts, 1s–10s) since shipping.create is expected
//      to be fast. Exceeds → TerminalError path → DLQ.
//   3. Imperative `orderEvents.publish(ctx, ...)` — after shipping succeeds,
//      republish a 'shipped' event so `advanceOrderOnShipped` can move
//      the entity state machine forward without this workflow knowing
//      about the entity at all.
//
// Orders whose id starts with `fail-` exercise the terminal branch.

import { TerminalError } from '@restatedev/restate-sdk';
import { defineWorkflow, on } from '@syncengine/server';
import { Retry, seconds } from '@syncengine/core';
import { orderEvents, OrderEvent, type OrderEventPayload } from '../events/orders.bus';
import { shipping } from '../services/shipping';

export const shipOnPay = defineWorkflow(
    'shipOnPay',
    {
        on: on(orderEvents).where((e) => e.event === OrderEvent.enum.paid),
        services: [shipping],
        retry: Retry.exponential({
            attempts: 2,
            initial: seconds(1),
            max: seconds(10),
        }),
    },
    async (ctx, event: OrderEventPayload) => {
        try {
            await ctx.services.shipping.create(event.orderId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new TerminalError(
                `shipOnPay: shipping.create(${event.orderId}) failed terminally — ${message}`,
            );
        }
        // Imperative publish (the other effect flavour — `publish()` is
        // the declarative form that lives inside `emit({ effects: [...] })`
        // on entity handlers). Validates payload against orderEvents'
        // schema; wraps the NATS write in ctx.run so replay is
        // deterministic.
        await orderEvents.publish(ctx, {
            orderId: event.orderId,
            event: OrderEvent.enum.shipped,
            total: event.total,
            at: Date.now(),
        });
    },
);
