// ── Orders Event Bus ────────────────────────────────────────────────────────
//
// Order lifecycle events (placed, paid, shipped, cancelled) fan out to every
// interested subscriber workflow. Used as the kitchen-sink bus demo — it
// exercises both effect-style `publish()` (from the order entity) and
// imperative `orderEvents.publish(ctx, ...)` (from the shipOnPay workflow).
//
//   order.pay()  ──publish()──▶  orderEvents  ◀──on().where(paid)──  shipOnPay
//                                     ▲                                  │
//                                     │              on success          │
//                                     └─── orderEvents.publish(ctx) ─────┘
//                                                                        │
//                                                  on shipping failure   │
//                                                  (TerminalError)       │
//                                                         │              │
//                                                         ▼              ▼
//                                      orderEvents.dlq ◀──on()─  ◀──on().where(shipped)─
//                                      (alertOnShippingFailure)  (advanceOrderOnShipped)

import {
    bus,
    Retention,
    Delivery,
    Retry,
    seconds,
    minutes,
    days,
} from '@syncengine/core';
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

/** Bus-wide default retry policy. Individual subscribers can still
 *  override this via their own `retry:` option (see shipOnPay for a
 *  tighter per-subscriber schedule). */
export const ORDER_EVENTS_RETRY = Retry.exponential({
    attempts: 3,
    initial: seconds(1),
    max: minutes(1),
});

export const orderEvents = bus('orderEvents', {
    schema: OrderEventSchema,
    // 30-day durability so DLQ replays stay meaningful across incident
    // windows. Fan-out delivery is also the default, but declaring it
    // explicitly documents the topology: every subscriber reads an
    // independent cursor over the same stream.
    retention: Retention.durableFor(days(30)),
    delivery: Delivery.fanout(),
});
