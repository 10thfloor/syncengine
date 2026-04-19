// ── shipOnPay Workflow ─────────────────────────────────────────────────────
//
// Subscriber workflow for the `orderEvents` bus. Fires on every event whose
// `event` field is `paid` — the `.where` predicate pushes that filter down
// to the JetStream consumer so we never invoke Restate for irrelevant
// events.
//
// On invocation the workflow calls the `shipping` service's `create`
// method. The service is stubbed for the demo: orders whose id starts
// with `fail-` throw, which we convert to a Restate `TerminalError`.
// A terminal error tells the dispatcher to stop retrying and publish
// the event to `orderEvents.dlq` — which the `alertOnShippingFailure`
// workflow subscribes to.

import { TerminalError } from '@restatedev/restate-sdk';
import { defineWorkflow, on } from '@syncengine/server';
import type { ServicePort } from '@syncengine/core';
import { orderEvents, OrderEvent, type OrderEventPayload } from '../events/orders.bus';
import { shipping } from '../services/shipping';

/** Typed shape of the hex-injected `ctx.services` bag visible to this
 *  workflow. Phase 1 is build-time only — the runtime injector that
 *  populates `ctx.services` from the declared `services: [...]` list
 *  lands with the BusDispatcher wiring. Until then the cast below is
 *  the forward-compatible shape. */
interface ShipOnPayServices {
    readonly shipping: ServicePort<typeof shipping>;
}

export const shipOnPay = defineWorkflow(
    'shipOnPay',
    {
        on: on(orderEvents).where((e) => e.event === OrderEvent.enum.paid),
        services: [shipping],
    },
    async (ctx, event: OrderEventPayload) => {
        const services = (ctx as unknown as { services: ShipOnPayServices }).services;
        try {
            await services.shipping.create(event.orderId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // TerminalError routes the event to `orderEvents.dlq` — the
            // BusDispatcher stops retrying and publishes a DeadEvent.
            throw new TerminalError(
                `shipOnPay: shipping.create(${event.orderId}) failed terminally — ${message}`,
            );
        }
    },
);
