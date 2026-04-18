// ── auditOrder Workflow ─────────────────────────────────────────────────────
//
// Kitchen-sink demo for `.orderedBy(fn)`. This subscriber logs every event
// on `orderEvents`, but with a serialisation guarantee: events for the
// same `orderId` run in lifecycle order (paid before shipped), while
// distinct orders run in parallel.
//
// Mechanism: the dispatcher derives Restate's invocation id as
// `orderEvents:<orderId>` instead of the default `orderEvents:<seq>`.
// Restate's single-writer-per-key semantics kick in — two events for
// O1 serialise onto the same virtual-object instance; events for O1
// and O2 never block each other.
//
// The log format is stable so the smoke test's per-order ordering
// assertion can grep for it without regex gymnastics.

import { defineWorkflow, on } from '@syncengine/server';
import { orderEvents, type OrderEventPayload } from '../events/orders.bus';

export const auditOrder = defineWorkflow(
    'auditOrder',
    {
        on: on(orderEvents).orderedBy((e) => e.orderId),
    },
    async (_ctx, event: OrderEventPayload) => {
        console.log(`[audit] order=${event.orderId} event=${event.event} at=${event.at}`);
    },
);
