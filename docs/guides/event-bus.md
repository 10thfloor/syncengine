# Event Bus Guide

> Phase 1 — `bus()` as the third effect type. See the
> [spec](../superpowers/specs/2026-04-20-event-bus-design.md) for the
> full design and the
> [migration doc](../migrations/2026-04-20-trigger-to-publish.md) if
> you're moving off `trigger()`.

## When to reach for a bus

| Primitive | Use for | Shape |
|---|---|---|
| `table` + `channel` | Reactive CRDT state clients read directly. | Durable; clients subscribe |
| `entity` | Aggregate state machines with RPC handlers. | Request/reply |
| `topic` | Ephemeral presence, cursors, low-stakes pub/sub. | No persistence |
| **`bus`** | **Typed domain events between server components.** | **Durable; server-only** |
| `workflow` / `webhook` / `heartbeat` | Orchestration. | Can `bus.publish(ctx, event)` imperatively |

A bus is the right answer when an entity wants to **announce** something ("OrderPaid") and one or more workflows should react — without the entity knowing who.

Browsers never subscribe to buses. If a UI needs to see bus-derived state, have a subscriber materialise the stream into a `table` or `entity` the client already syncs.

## Five-line declaration

```ts
// src/events/orders.bus.ts
import { bus } from '@syncengine/core';
import { z } from 'zod';

export const OrderEvent = z.enum(['placed', 'paid', 'shipped', 'cancelled']);

export const orderEvents = bus('orderEvents', {
    schema: z.object({
        orderId: z.string(),
        event: OrderEvent,
        at: z.number(),
    }),
});
```

Defaults: 7-day retention, 1 M-message cap, fan-out delivery, file storage, 1-minute dedup, auto-DLQ at `orderEvents.dlq`.

Scaffold with:

```bash
syncengine add bus orderEvents
```

## Publishing from an entity (declarative)

`publish(bus, payload)` is the third effect type alongside `insert()` and `trigger()` (the latter is deprecated — see the migration doc).

```ts
import { defineEntity, emit, publish } from '@syncengine/core';
import { orderEvents, OrderEvent } from '../events/orders.bus';

export const order = defineEntity('order', {
    state: { status: text(), total: integer() },
    handlers: {
        pay(state) {
            return emit({
                state: { ...state, status: 'paid' as const },
                effects: [
                    publish(orderEvents, {
                        orderId: state.id,
                        event: OrderEvent.enum.paid,
                        at: Date.now(),
                    }),
                ],
            });
        },
    },
});
```

The entity runtime validates the payload against the bus schema, persists state, then publishes to NATS JetStream inside a `ctx.run` so Restate's deterministic replay never double-fires.

## Publishing from a workflow / webhook / heartbeat (imperative)

Orchestrators already have `ctx`, so they use the method form:

```ts
await orderEvents.publish(ctx, {
    orderId: event.orderId,
    event: OrderEvent.enum.shipped,
    at: Date.now(),
});
```

## Subscribing

Subscribers are ordinary workflows with an `on:` declaration. `ctx.services` injection works the same as in non-subscriber workflows.

```ts
// src/workflows/ship-on-pay.workflow.ts
import { defineWorkflow, on } from '@syncengine/server';
import { orderEvents, OrderEvent } from '../events/orders.bus';
import { shipping } from '../services/shipping';

export const shipOnPay = defineWorkflow(
    'shipOnPay',
    {
        on: on(orderEvents).where((e) => e.event === OrderEvent.enum.paid),
        services: [shipping],
    },
    async (ctx, event) => {
        await ctx.services.shipping.create(event.orderId);
    },
);
```

Under the hood, the framework opens one durable JetStream consumer per subscriber and routes each filtered message to a Restate workflow invocation keyed by `<bus>:<seq>` so idempotent replay works.

## Retry + DLQ

Defaults that you get for free:

- 3 retry attempts, exponential backoff (1s → 10s → 60s).
- 5-minute per-attempt timeout.
- Auto-DLQ at `<bus>.dlq`, 30-day retention.

Overrides live on the subscriber's options block. Terminal failures land on the DLQ:

```ts
import { TerminalError } from '@restatedev/restate-sdk';

async (ctx, event) => {
    try {
        await ctx.services.shipping.create(event.orderId);
    } catch (err) {
        if (err instanceof FundsInsufficientError) {
            throw new TerminalError('do not retry');
        }
        throw err;  // everything else is retriable
    }
}
```

Subscribe to the DLQ like any other bus:

```ts
export const alertOnShippingFailure = defineWorkflow(
    'alertOnShippingFailure',
    {
        on: on(orderEvents.dlq),
        services: [notifications],
    },
    async (ctx, dead) => {
        await ctx.services.notifications.sendSlack({
            channel: '#alerts',
            text: `${dead.workflow} failed ${dead.attempts}× on order ${dead.original.orderId}: ${dead.error.message}`,
        });
    },
);
```

## Orphan-bus warning

Declare a bus without any subscriber workflow and the framework prints a warning at boot:

```
[syncengine] bus('orderEvents') has no subscribers — events will
accumulate on JetStream until the retention window expires.
Declare a defineWorkflow({ on: on(orderEvents), ... }) or remove the bus.
```

Auto-DLQ buses (`*.dlq`, `*.dead`) are exempted — it's common to let them pile up.

## Runtime — how dispatchers spawn

Phase 2a wired the subscriber lifecycle. Every `syncengine start` process (and every handlers container in scale-out) boots a `BusManager` that owns the dispatcher-per-`(workspace × subscriber)` graph.

**Spawn triggers**

1. **At boot.** The manager calls JetStream's `streams.list()`, picks every stream whose name starts with `WS_`, and spawns a `BusDispatcher` for every subscriber workflow × every existing workspace.
2. **On workspace provision.** The manager subscribes to the `syncengine.workspaces` topic (the same broadcast the gateway uses for its browser-facing registry). Every `WORKSPACE_PROVISIONED` message triggers a spawn for that workspace × every subscriber.

Spawns are idempotent — keyed on `<wsKey>::<subscriberName>` — so boot discovery + a registry broadcast landing in the same second won't double-spawn.

**Durable-consumer restart**

Each dispatcher opens a JetStream consumer named `bus:<busName>:<subscriberName>` (with `.` sanitised to `_`, so DLQ durables like `bus:orderEvents_dlq:alertOnShippingFailure` don't hit NATS's dot ban). That name is stable across restarts: kill `syncengine start`, re-run it, and the dispatcher resumes from the last ack'd sequence. No replay, no duplicates.

**Failure isolation**

Dispatchers start in parallel via `Promise.allSettled`. One subscriber failing to boot (flaky NATS, bad retry config) logs a warn and drops its handle; the rest come up normally. A later `onWorkspaceProvisioned` call retries just the dropped pair.

**Shutdown**

`BusManager` installs `SIGTERM` / `SIGINT` handlers that drain every dispatcher. Set `SYNCENGINE_NO_BUS_SIGNALS=1` to skip this — the scale-out serve binary already owns shutdown through its shared controller.

## Phase 2 preview (what's still ahead)

- `.orderedBy(fn)`, `.ordered()`, `.concurrency(n)`, `.rate(Rate.perSecond(n))`, `.key(fn)` on `on()`.
- `Layer 3` `JetStream.*` escape hatch for every NATS option.
- `BusMode.inMemory()` + `override()` for tests without a running NATS.
- Devtools "Buses" tab with live tail + DLQ inspector.
- Scale-out smoke (emit from edge, handler consumes).
- Subscriber workflow `ctx.services` injection (the hex-service wiring that workflows in non-bus code paths already have — bus-subscriber workflows currently see `ctx.services === undefined`).
- Terminal-vs-retriable classification in the dispatcher (Restate 1.6 returns `TerminalError` as HTTP 500 with a JSON body; the DLQ path waits on the classifier).

## Links

- Spec: `docs/superpowers/specs/2026-04-20-event-bus-design.md`
- Plan: `docs/superpowers/plans/2026-04-20-event-bus.md`
- Migration: `docs/migrations/2026-04-20-trigger-to-publish.md`
- Demo: `apps/test/src/events/orders.bus.ts` + `apps/test/src/workflows/ship-on-pay.workflow.ts`
