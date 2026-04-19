// ── Orders Event Bus ────────────────────────────────────────────────────────
//
// The `orderEvents` bus carries order lifecycle events (placed, paid,
// shipped, cancelled) from the `order` entity to any subscriber workflow.
//
// Phase 1 event-bus demo wiring:
//
//   order.pay()  ──publish()──▶  orderEvents   ◀──on()──  shipOnPay
//                                     │
//                                     └── on shipping failure ──▶
//                                           TerminalError
//                                                │
//                                                ▼
//                                         orderEvents.dlq  ◀──on()──  alertOnShippingFailure
//
// The auto-generated `orderEvents.dlq` accessor carries `DeadEvent<OrderEvent>`
// — every subscriber workflow that terminally fails one of these events
// lands there, and `alertOnShippingFailure` subscribes to log the failure.

import { bus, Retention, days } from '@syncengine/core';
import { z } from 'zod';

/** Typed enum for the lifecycle event field. Use `OrderEvent.enum.paid`
 *  at publish sites and `e.event === OrderEvent.enum.paid` in `.where`
 *  predicates — no magic strings. */
export const OrderEvent = z.enum(['placed', 'paid', 'shipped', 'cancelled']);
export type OrderEvent = z.infer<typeof OrderEvent>;

export const OrderEventSchema = z.object({
    orderId: z.string(),
    event: OrderEvent,
    total: z.number(),
    at: z.number(),
});

export type OrderEventPayload = z.infer<typeof OrderEventSchema>;

export const orderEvents = bus('orderEvents', {
    schema: OrderEventSchema,
    // Layer 2 override: durable for 30 days so DLQ replays stay
    // meaningful across multi-day incident windows. Fan-out (the
    // default) lets shipOnPay + future subscribers read the same
    // stream independently.
    retention: Retention.durableFor(days(30)),
});
