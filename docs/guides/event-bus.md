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

The entity runtime validates the payload against the bus schema, persists state, then publishes to NATS JetStream via `js.publish()` inside a `ctx.run`. The JetStream `PubAck` confirms durable persistence before the `ctx.run` completes — if the ack fails, Restate retries the handler. Deterministic replay ensures effects never double-fire.

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

## Subscription modifiers

Every modifier composes; later calls override earlier ones of the same kind. Pure-value, manifest-serialisable — the builder returns a fresh `Subscription<T>` each call.

```ts
on(orderEvents)
    .where(e => e.event === 'paid')
    .orderedBy(e => e.orderId)
    .concurrency(Concurrency.global(10))
    .rate(Rate.perSecond(50))
    .from(From.latest())
```

### Ordering family

| Modifier | Restate invocation id | Semantics |
|---|---|---|
| _(default)_ | `${busName}:${seq}` | Exactly-once per JetStream seq; full parallelism. |
| `.ordered()` | `${busName}:singleton` | Single in-flight invocation; redeliveries collapse. |
| `.orderedBy(fn)` | `${busName}:${fn(event)}` | One in-flight per key — keys run in parallel, same-key serialises. |
| `.key(fn)` | `fn(event)` | User owns the whole id (no `${busName}:` prefix). |

All three compile to the same thing under the hood: Restate's single-writer-per-virtual-object-key gives the serialisation for free. `.ordered()` is exactly `.orderedBy(() => 'singleton')`.

### Throttles

| Modifier | Wire mechanism |
|---|---|
| `.concurrency(Concurrency.global(n))` | `max_ack_pending = n` on the durable JetStream consumer. |
| `.concurrency(Concurrency.perKey(n))` | ⏸ deferred — blocked on concurrent-dispatch refactor. |
| `.rate(Rate.perSecond(n))` _(also `.perMinute` / `.perHour`)_ | Lazy-refill token bucket in the dispatcher; NAKs with exact `delayMs` when empty so JetStream re-delivers at the right time. |

Rate-limited subscribers don't burn tokens on `.where()`-rejected events and don't hold Restate virtual-object slots warm while throttled — the gate runs after the predicate and before the POST.

## Flipping buses to in-memory via config

For integration tests that boot the full app (HTTP + RPC + WebSocket) but don't want to run NATS, declare an override file and wire it into `syncengine.config.ts`:

```ts
// src/events/test/index.ts
import { override, BusMode } from '@syncengine/core';
import { orderEvents } from '../orders.bus';

export default [
    override(orderEvents, { mode: BusMode.inMemory() }),
];
```

```ts
// syncengine.config.ts
export default config({
    workspaces: { resolve: ... },
    services: {
        overrides: process.env.NODE_ENV === 'test'
            ? () => import('./src/events/test')
            : undefined,
    },
});
```

Under `NODE_ENV=test` the boot path loads the module, splits the overrides by `$tag` (service vs bus), and:
- **Service overrides** land in the `ServiceContainer` — production `payments` stays for prod, test stubs for tests.
- **Bus overrides** feed a `modeOf(busName)` resolver the bus runtime consults. Buses flipped to `inMemory` skip the JetStream dispatcher entirely; publishes route through an in-process `InMemoryBusDriver` (same implementation the `createBusTestHarness` uses).

Net result: `syncengine start` in a test env boots without a broker. Every `bus.publish(ctx, ...)` on a flipped bus fires subscribers inline, `TerminalError` still routes to `<bus>.dlq`, and subscriber workflows see the same typed `ctx.services` they would in production.

For pure vitest unit tests, use `createBusTestHarness` directly (below) — it's faster and doesn't need a running HTTP server.

## Testing without NATS

`createBusTestHarness()` from `@syncengine/server/test` stands in for NATS + Restate:

```ts
import { createBusTestHarness } from '@syncengine/server/test';
import { shipOnPay } from './workflows/ship-on-pay.workflow';
import { shipping } from './services/shipping';

const harness = createBusTestHarness({
    workflows: [shipOnPay],
    services: [shipping],
});

await orderEvents.publish(harness.ctx(), { orderId: 'O1', event: 'paid', total: 10, at: 0 });

expect(harness.dispatchedFor(shipOnPay)).toHaveLength(1);
```

Capture-only methods (`publishedOn(bus)`, `capturePublishEffects(state)`) work without any `workflows` list — handy for asserting "did my entity publish?" in pure unit tests. TerminalError from a subscriber routes to `<bus>.dlq` just like in production; DLQ subscribers fire in the same pass.

## Links

- Spec: `docs/superpowers/specs/2026-04-20-event-bus-design.md`
- Plans: `docs/superpowers/plans/2026-04-20-event-bus.md` (Phase 1), `...-phase-2a.md`, `...-phase-2b.md`
- Migration: `docs/migrations/2026-04-20-trigger-to-publish.md`
- Demo: `apps/test/src/events/orders.bus.ts` + workflows under `apps/test/src/workflows/`
