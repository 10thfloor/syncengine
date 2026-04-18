// ── advanceOrderOnShipped Workflow ─────────────────────────────────────────
//
// Kitchen-sink pattern: the bus decouples the "what happened" from the
// "what to do next". shipOnPay publishes a `shipped` event on the same
// bus it subscribes to, and this workflow — which knows nothing about
// shipping — reacts by advancing the entity state machine.
//
// This is also the most idiomatic place for hex integration: entity
// refs obtained through `ctx` rather than `ctx.services`, because the
// entity is part of _this_ app, not a driven port. `ctx.services` is
// reserved for external-world adapters (APIs, SaaS, vendor SDKs).

import { defineWorkflow, on, entityRef } from '@syncengine/server';
import { order } from '../entities/order.actor';
import { orderEvents, OrderEvent, type OrderEventPayload } from '../events/orders.bus';

export const advanceOrderOnShipped = defineWorkflow(
    'advanceOrderOnShipped',
    {
        on: on(orderEvents).where((e) => e.event === OrderEvent.enum.shipped),
    },
    async (ctx, event: OrderEventPayload) => {
        await entityRef(ctx, order, event.orderId).markShipped();
    },
);
