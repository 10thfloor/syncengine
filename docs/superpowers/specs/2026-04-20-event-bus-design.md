# `bus()` — Server-Side Event Bus Design

> Framework-native, workspace-scoped event bus backed by JetStream and
> driven by Restate workflows. First-class retry / DLQ / ordering /
> concurrency. No client exposure — internal vocabulary for server
> components.

## Goals

- Close the **"typed server-to-server event"** gap. Today developers
  either abuse `topic` (ephemeral, best-effort), bend `channel` (CRDT
  semantics), or string together ad-hoc workflow invocations. Each
  path has the wrong shape, the wrong guarantees, or both.
- **Zero transport knowledge.** Developers never import
  `@nats-io/*`, never write subject strings, never manage consumer
  state. The framework owns JetStream plumbing end-to-end.
- **Durable execution reuse.** Event-driven workflows lean on
  Restate's existing retry + dedup + replay machinery. The bus is
  the delivery layer; Restate is the durable-executor layer; neither
  has to reinvent the other.
- **Workspace-scoped by construction.** Same multi-tenant guarantee
  every other primitive gives: one workspace's events never leak into
  another's consumers. Users don't think about it.
- **No magic strings.** Durations, backoffs, rates, DLQ targets, and
  cross-references all flow through typed factory helpers or primitive
  refs. Name strings are limited to the framework-registration call
  (same convention as `entity()` / `workflow()` / `channel()`).
- **First-class devtools.** Every event stream, every subscriber,
  every DLQ is surfaced in the devtools panel. Inspect payloads,
  re-emit from the DLQ, disable subscribers without redeploy.

## Non-Goals

- **Client subscription.** Browsers never attach to a bus directly.
  Exposing internal events breaks access control, couples UI to
  domain vocabulary, and amplifies replay load. See §7 for the
  sanctioned pattern (curated `feed()` primitive — future spec).
- **Cross-workspace fanout.** v1 publishes stay inside the emitting
  workspace's JetStream. Cross-workspace integration goes through
  an explicit gateway (webhook, integration workflow, etc.).
- **Schema evolution tooling.** Versioning strategy is "add fields,
  never remove, bump the bus name on breaking changes." No automated
  migrations or dual-write helpers in v1.
- **Exactly-once publish.** JetStream gives at-least-once delivery.
  Restate's per-invocation dedup gives effective-exactly-once
  **processing**, which is what subscribers care about. We won't
  attempt idempotent publish from the caller side in v1.
- **External brokers.** Kafka, RabbitMQ, Redis Streams are all
  plausible future transports, but v1 ships JetStream-only. The
  internal seam (§8) is designed to allow substitution later.
- **Request-reply over the bus.** Buses are fire-and-forget. If you
  want a response, use `entity` RPC or a workflow.

---

## 1. DSL — three surfaces

### 1a. Declaring a bus

```ts
// apps/*/src/events/orders.bus.ts
import { bus } from '@syncengine/core';
import { days } from '@syncengine/core/duration';
import { z } from 'zod';

export const OrderEvent = z.enum(['created', 'paid', 'shipped', 'cancelled']);
export type OrderEvent = z.infer<typeof OrderEvent>;

export const orderEvents = bus('orderEvents', {
    schema: z.object({
        orderId: z.string(),
        event: OrderEvent,
        at: z.number(),
    }),
    retention: {
        maxAge: days(30),
        maxMessages: 1_000_000,
    },
});
```

- **Discovery**: file-suffix convention `.bus.ts`, mirroring
  `.entity.ts` / `.workflow.ts` / `.heartbeat.ts`. The Vite plugin's
  actor scanner picks them up and emits a manifest entry.
- **Naming**: `bus('orderEvents', ...)` — the name is the NATS
  subject fragment (`ws.<wsId>.bus.orderEvents`) and the registry
  key. Required for framework wiring; same convention as every other
  declarative primitive.
- **Schema**: zod, with full inference flowing into `.emit` and
  subscriber handlers. Framework validates at emit-time; invalid
  payloads raise a `TerminalError` before publish.
- **Retention**: typed via `Duration` factories (`days(30)`,
  `hours(12)`, `minutes(15)`). Translated to JetStream
  `max_age` + `max_msgs` at stream-update time.

### 1b. Emitting

```ts
// From any Restate-backed handler (entity / workflow)
import { order } from '../entities/order.entity';
import { orderEvents } from '../events/orders.bus';

async pay(ctx, req: { paymentId: string }) {
    await chargeCard(ctx, req.paymentId);
    await orderEvents.emit(ctx, {
        orderId: ctx.key,
        event: OrderEvent.paid,
        at: Date.now(),
    });
    return { status: 'paid', paymentId: req.paymentId };
}
```

- **One line**, no `ctx.run` boilerplate. Framework wraps the NATS
  publish internally so Restate's deterministic replay reuses the
  journaled outcome.
- **Payload validated** against the zod schema before publish.
  Validation failure throws `TerminalError` (replays won't help).
- **Non-terminal network failures** automatically retry inside
  `ctx.run`.
- Emitters work from **any tier** — entity handler, workflow,
  heartbeat, standalone subscriber. The framework routes through
  the same gateway-core NATS connection already in use.

### 1c. Subscribing

```ts
// apps/*/src/workflows/ship.workflow.ts
import { workflow, on } from '@syncengine/server';
import { minutes, hours } from '@syncengine/core/duration';
import { Backoff, TerminalError } from '@syncengine/core';
import { orderEvents, OrderEvent } from '../events/orders.bus';

export const shipOnPay = workflow('shipOnPay', {
    on: on(orderEvents)
        .where(e => e.event === OrderEvent.paid)
        .orderedBy(e => e.orderId)
        .concurrency(10),
    retry: {
        attempts: 10,
        backoff: Backoff.exponential({ initialMs: 5_000, maxMs: 300_000 }),
    },
    timeout: minutes(15),
    dlq: orderEvents.dlq,
    async run(ctx, event) {
        await ctx.run('create-shipment', () =>
            shippingApi.create(event.orderId),
        );
        await ctx.sleep(hours(48));
        await orderEvents.emit(ctx, {
            orderId: event.orderId,
            event: OrderEvent.shipped,
            at: Date.now(),
        });
    },
});
```

- **`on(bus)`** — declarative subscription. Can chain `.where(fn)`,
  `.orderedBy(fn)`, `.ordered()`, `.concurrency(n)`, `.rate(Rate.perSecond(100))`.
- **Filter `.where`** evaluated server-side before workflow
  invocation — the framework dispatches the NATS message body
  through the predicate without spinning up Restate for no-ops.
- **`orderedBy(fn)`** — events that return the same key are
  serialized (one in flight per key). Distinct keys run in parallel.
  Implemented by keying the Restate virtual object on `fn(event)`.
- **`concurrency(n)`** — global cap on in-flight invocations for
  this subscriber.
- **`retry` / `timeout`** — sensibly defaulted (§3), overridable
  per subscriber.
- **`dlq`** — receives events that exhaust retries. Either the
  auto-generated `bus.dlq` (same-shape fallback) or a user-declared
  bus passed by reference.

---

## 2. Delivery semantics

```
┌───────────┐      NATS JetStream        ┌────────────┐
│  emit()   │──────────────────────────▶│ Consumer   │
│  (in      │   subject: ws.<wsId>.      │ (per       │
│   ctx.run)│   bus.<name>               │  subscriber)│
└───────────┘                            └─────┬──────┘
                                               │
                                               ▼
                                     ┌──────────────────┐
                                     │ Restate workflow │
                                     │ invocation,      │
                                     │ keyed by         │
                                     │ bus:seq or       │
                                     │ orderedBy(fn)    │
                                     └──────────────────┘
```

- **At-least-once delivery** from JetStream to the dispatcher.
- **Exactly-once processing** via Restate's invocation-id dedup.
  Framework derives the invocation id from `<busName>:<seq>` so a
  redelivered NATS message lands on the existing Restate invocation
  instead of double-running.
- **Workflow completion** → NATS `ack` → message evictable under
  the retention policy.
- **Workflow exhausts retries** → publish dead-event (§3) →
  NATS `ack` on the original. The DLQ bus owns the lifecycle from
  there.

---

## 3. Retry, timeout, DLQ

### 3a. Defaults (zero-config path)

| Concern | Default |
|---|---|
| Retry attempts | 3 |
| Backoff | `Backoff.exponential({ initialMs: 1_000, maxMs: 60_000 })` |
| Timeout per attempt | `minutes(5)` |
| DLQ | Auto — `<bus>.dlq` (same schema), `days(30)` retention |
| Dedup key | `<busName>:<seq>` |

### 3b. Overrides

Every default is replaceable via typed values; string presets are
deliberately excluded so typo-driven bugs can't regress to a bad
policy silently.

### 3c. `TerminalError` short-circuit

Throwing `TerminalError` (imported from `@syncengine/core`) from the
handler bypasses retry. The event goes straight to the DLQ with
`attempts = current`. Use for domain refusals (`INSUFFICIENT_FUNDS`,
`INVALID_CONFIG`) that won't resolve with more tries.

### 3d. DLQ shape

```ts
interface DeadEvent<T> {
    readonly original: T;
    readonly error: {
        message: string;
        code?: string;
        stack?: string;
    };
    readonly attempts: number;
    readonly firstAttemptAt: number;
    readonly lastAttemptAt: number;
    /** Subscriber that gave up. */
    readonly workflow: string;
}
```

DLQ buses are just buses — subscribe to them the same way:

```ts
export const alertOnDead = workflow('alertOnDead', {
    on: on(orderEvents.dlq),
    async run(ctx, dead) {
        await sendSlackAlert(ctx, dead);
        if (dead.attempts < 50) {
            await ctx.sleep(hours(1));
            await orderEvents.emit(ctx, dead.original);
        }
    },
});
```

### 3e. Auto-DLQ schema

`<bus>.dlq` is a typed accessor on `BusRef<T>`. At build time the
framework registers a sibling bus named `<bus>.dlq` with schema
`DeadEvent<T>`. Users who want a custom-named or custom-retention
DLQ declare their own `bus(...)` and pass it by reference
(`dlq: shippingFailures`).

---

## 4. Ordering, concurrency, rate

```ts
on: on(orderEvents)
    .orderedBy(e => e.orderId)   // per-key serialisation
    .concurrency(10)             // global cap
    .rate(Rate.perSecond(100)),  // token bucket
```

| Modifier | Semantics |
|---|---|
| `.ordered()` | Strict — one in-flight invocation across the whole subscriber. |
| `.orderedBy(fn)` | Partitioned — one in-flight per `fn(event)` key. Distinct keys parallel. |
| `.concurrency(n)` | Hard cap regardless of partitioning. Extra events queue in JetStream. |
| `.rate(Rate.perSecond(n))` | Token bucket. `Rate.perMinute`, `Rate.perHour` as sibling factories. |

Ordering implementation: the framework creates a Restate virtual
object keyed by `fn(event)` that owns the workflow invocation. Two
messages with the same key serialise through the object's
single-writer guarantee.

---

## 5. Storage + retention

Every bus lives in the workspace's JetStream stream
(`WS_<wsKey>`) under subject `ws.<wsKey>.bus.<busName>`.

- **Retention**: framework reconciles declared `retention` against
  the stream's per-subject policy at `syncengine build` time
  (manifest entry) and at server boot (idempotent).
- **Cleanup**: JetStream enforces `max_age` + `max_msgs` natively.
  Workflows handlers never see ack-failed messages; NATS drops them.
- **Consumer durability**: per-subscriber durable consumers named
  `<workspaceHash>:bus:<busName>:<workflowName>`. Survive server
  restart, resume at the last ack'd sequence.
- **Teardown**: deleting a workspace destroys the stream and every
  bus subject alongside.

---

## 6. Cross-tier behaviour

Buses are emit-and-subscribe from **any server-side tier**:

- `syncengine start` (single-process) — emit + subscribe both run in
  the same Node process.
- `syncengine serve` scale-out — edge can `emit` (handy for
  operational events), handlers holds all subscribers.
- Both tiers share the same gateway-core NATS connection plumbing;
  `bus.emit` picks the correct transport via `connectNats()`.

Subscribers, by construction, only run in the **handlers** tier —
they're workflow declarations registered with Restate, and only the
handlers container speaks to Restate's H2C endpoint.

---

## 7. Client-facing event streams (non-goal)

Buses are **never reachable from the browser**. The client already has:

- `table` + `channel` — reactive CRDT state.
- `entity` — request/reply for aggregated state.
- `topic` — ephemeral presence / cursors.

If an app needs to surface bus activity in the UI, the sanctioned
pattern is to **materialise** the bus via a subscriber that writes
to a `table` or updates an `entity`. The UI reads the table/entity
— it never sees the bus.

A future `feed()` primitive may add a direct exposure path once the
access-control + versioning story is nailed down. Deferred.

---

## 8. Implementation sketch

### 8a. Package layout

| Package | Responsibility |
|---|---|
| `@syncengine/core` | `bus()` DSL, `Backoff` / `Rate` / `Duration` factories, `TerminalError`, `DeadEvent<T>` type. |
| `@syncengine/core/duration` | Duration factory helpers. |
| `@syncengine/server` | `on()` fluent builder, `workflow()` integration, dispatcher that maps NATS messages to Restate invocations. |
| `@syncengine/gateway-core` | NATS/JetStream plumbing already exists; the dispatcher reuses `WorkspaceBridge`'s stream setup. |
| `@syncengine/vite-plugin` | `.bus.ts` discovery, manifest emission, dev-mode dispatcher spin-up. |
| `@syncengine/cli/build` | Manifest → server-entry wiring so subscribers register at boot. |

### 8b. Manifest entry

```jsonc
{
  "buses": [
    {
      "name": "orderEvents",
      "path": "src/events/orders.bus.ts",
      "retention": { "maxAge": 2592000000, "maxMessages": 1000000 }
    }
  ],
  "subscribers": [
    {
      "name": "shipOnPay",
      "workflowPath": "src/workflows/ship.workflow.ts",
      "busName": "orderEvents",
      "ordering": { "kind": "byKey", "keyFn": "<serialised>" },
      "concurrency": 10,
      "retry": { "attempts": 10, "backoff": { ... } },
      "timeout": 900000,
      "dlq": "orderEvents.dlq"
    }
  ]
}
```

### 8c. Dispatcher

Single long-running coroutine per subscriber inside the handlers
container. Uses `gateway-core`'s JetStream client to pull messages,
applies the `.where` filter, derives the invocation id, and calls
Restate's ingress API (`POST /workflow_<name>/<key>/run`). On
non-terminal failure it `nak`s with backoff; on exhaustion it
publishes to the DLQ bus and `ack`s the original.

### 8d. Ordering

`.orderedBy(fn)` compiles to a workflow key derived from
`fn(event)` — Restate's virtual-object-per-key semantics do the
serialisation for free. `.ordered()` is the degenerate case:
`fn = () => 'singleton'`.

### 8e. Determinism

`bus.emit(ctx, payload)` internally does:

```ts
const seq = await ctx.run(`bus:${name}:emit-seq`, async () => {
    const pub = await nc.publish(subject, JSON.stringify(payload));
    return pub.seq;   // JetStream assigns this
});
```

So on replay the original sequence number is reused from the journal
— critical for the invocation-id dedup that the subscriber relies on.

---

## 9. Devtools

A new **Buses** tab in the devtools panel:

- Live-tail every bus in the current workspace. Click a message to
  inspect the payload and its downstream subscriber invocations.
- Subscriber table: status (healthy / backlogged / DLQ'd), last-ack
  sequence, in-flight count, retry-exhausted count.
- DLQ inspector: one row per dead-event. Actions: re-emit, copy
  payload, mark archived.
- Subject-tree view for users who want to reason about NATS layout.

---

## 10. Success criteria

1. A 30-line `bus()` + `workflow({ on })` pair works against
   `apps/test` and `apps/notepad` without touching NATS, Restate,
   or JetStream directly.
2. `syncengine start` and `syncengine serve` both support emit +
   subscribe without config changes. Same code runs both.
3. Poison events land in the DLQ after the declared attempts and
   show up in devtools, re-emittable in one click.
4. `orderedBy(fn)` serialises per-key under sustained load
   (e.g. 1,000 events spread across 10 keys → 10 parallel, 100
   sequential per key).
5. Workspace deletion cleans up every bus, every consumer, every
   DLQ entry belonging to it.
6. Types flow end-to-end: `on(bus).where(e => ...)` narrows `e` to
   the zod-inferred payload shape; `workflow.run(ctx, event)`
   receives the same.

---

## 11. Open questions

- **Subject wildcards for multi-bus subscribers.** Should `on(bus1, bus2)`
  fan a single workflow across multiple buses, or force one subscriber
  per bus? First-pass: one bus per subscriber; revisit if the demo
  surfaces a use case.
- **Priority / weighted rate limits.** Not in v1. JetStream's
  per-consumer rate isn't preemption-friendly; revisit when the PaaS
  demands it.
- **Pause / disable without deploy.** A devtools toggle that parks
  the consumer without crashing the workflow. Implementable via
  Restate's admin API; defer to Phase 2.
- **Cross-workspace events.** Out of scope for v1. An operator-level
  "fan-in" bus would need its own spec.

---

## 12. Phased delivery

### Phase 1 — the primitive itself (~1 week)

- `bus()` DSL + `Duration` / `Backoff` / `Rate` factories.
- Vite-plugin `.bus.ts` discovery.
- Manifest entry.
- `bus.emit(ctx, ...)` with ctx.run wrapping + schema validation.
- Single-process dispatcher: subscriber-per-workflow, filter + invoke,
  retry via Restate, terminal → DLQ.
- Smoke: one bus, one subscriber, one demo workflow.

### Phase 2 — DX hardening

- Ordering (`.ordered` / `.orderedBy`), concurrency, rate limits.
- Auto-DLQ (`bus.dlq`) + `DeadEvent<T>` type surface.
- Devtools "Buses" tab.

### Phase 3 — cross-tier correctness

- Scale-out compose smoke: emit from edge, handler consumes.
- Workspace teardown wipes buses + DLQs.
- Load bench (oha-style) against a subscribe workflow.

### Phase 4 — future work (separate specs)

- `feed()` — curated client-facing streams derived from buses.
- External transport adapters (Kafka / Redis Streams).
- Cross-workspace fan-in.
