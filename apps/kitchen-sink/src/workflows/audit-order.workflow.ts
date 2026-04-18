// ── auditOrder Workflow ─────────────────────────────────────────────────────
//
// Kitchen-sink demo for the bus modifier family. Exercises three of them
// at once:
//
//   .orderedBy(e => e.orderId)       — Restate invocation id becomes
//                                      `orderEvents:<orderId>`, so events
//                                      for the same order serialise.
//   .concurrency(Concurrency.global(8))
//                                    — at most 8 in-flight audit
//                                      invocations across all orders at
//                                      any moment (JetStream
//                                      max_ack_pending on the durable
//                                      consumer).
//
// Distinct orders run in parallel up to the global cap; same-order events
// stay ordered. The log format is stable so the smoke script's per-order
// ordering assertion can grep for it without regex gymnastics.

import { defineWorkflow, on } from '@syncengine/server';
import { Concurrency } from '@syncengine/core';
import { orderEvents, type OrderEventPayload } from '../events/orders.bus';
import { ordersAudited } from '../orders.metrics';

export const auditOrder = defineWorkflow(
    'auditOrder',
    {
        on: on(orderEvents)
            .orderedBy((e) => e.orderId)
            .concurrency(Concurrency.global(8)),
    },
    async (_ctx, event: OrderEventPayload) => {
        console.log(`[audit] order=${event.orderId} event=${event.event} at=${event.at}`);
        // Bus subscribers run inside `instrument.busConsume`, which
        // installs an observe scope frame. `.add()` below auto-tags
        // with workspace + primitive='bus' + name=<busName> — no need
        // to thread ctx attributes through by hand.
        ordersAudited.add(1, { event: event.event });
    },
);
