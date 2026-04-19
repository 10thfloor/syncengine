# `bus()` — Event Bus as the Third Effect Type

> JetStream-backed domain-events primitive that slots into the
> hex framework's existing effect-declaration vocabulary. Entity
> handlers `publish()` alongside `insert()` and `trigger()`.
> Subscribers are workflows with an `on:` declaration. Services
> inject the same way they do everywhere else. No new mental model,
> just a new effect type.

## Context & positioning

The hex framework (spec `2026-04-19-hexagonal-framework-design.md`)
gave users a vocabulary:

- **Domain** (pure): `schema`, `entity`, views.
- **Ports** (typed adapters): `service()`, `override()`.
- **Orchestrators** (async, receive `ctx.services`): workflows,
  webhooks, heartbeats.
- **Effects** (declared, not imperative): `emit({ state, effects:
  [insert(...), trigger(...)] })`.

The hex spec explicitly calls out an event bus as future work
(§Future Phases: *"typed domain events as an alternative to
`emit({ trigger })` for complex choreography"*). This doc spec's
that work.

The key framing choice: `bus()` is **not** a separate coordination
primitive on top of the hex stack. It is **the third effect type**,
sitting next to `insert()` and `trigger()`. Subscribers **reuse
`defineWorkflow`** — no new registrant, no new ctx shape, no new
file-suffix convention beyond `.bus.ts`.

## Goals

- **Slot into existing vocabulary.** `publish(bus, event)` joins
  `insert()` and `trigger()` inside `emit({ effects: [...] })`.
  Subscribers are `defineWorkflow(..., { on: on(bus), services })`.
- **Meteor-easy for the 90% case.** Common EDD patterns (fan-out,
  work queue, DLQ + alert, replay-from-start, compensating saga)
  are one-liners on the subscriber.
- **Full JetStream control for power users.** A typed escape hatch
  exposes every JetStream knob without strings.
- **No magic strings anywhere.** `Retention`, `Delivery`, `Storage`,
  `From`, `Rate`, `Backoff`, `Retry`, `Concurrency`, `BusMode`,
  `JetStream.*` are all typed factory namespaces.
- **Services injection for free.** Subscribers declare
  `services: [payments, shipping]` like workflows already do; the
  port types flow through.
- **Testing via `override()`** — same mechanism users learned for
  services.
- **Workspace-scoped by construction.** One workspace's events
  never reach another's consumers.

## Non-Goals

- **Client subscription.** Buses stay server-side. The browser
  reads materialised state (`table`, `entity`, `topic`). A future
  `feed()` primitive may add curated client streams — out of scope
  here.
- **Cross-workspace fan-out.** Emits stay inside the emitting
  workspace. Cross-workspace coordination goes through an explicit
  gateway (webhook, integration workflow).
- **Replacing `trigger()`.** `trigger(workflow, input)` keeps its
  place for tight-coupled "I know what runs next" cases.
  `publish()` is for loose-coupled "announce and let subscribers
  decide." See §1e.
- **Schema evolution tooling.** v1 rule: add-only fields, bump the
  bus name on breaking changes. No automated migrations or
  dual-write helpers yet.
- **Exactly-once publish.** JetStream gives at-least-once delivery;
  Restate's invocation-id dedup gives effective-exactly-once
  **processing** — that's what subscribers care about.
- **External brokers.** Kafka / Redis Streams are plausible future
  transports. v1 ships JetStream only. Internal seam designed to
  allow substitution later.
- **Request-reply.** Fire-and-forget only. Use `entity` RPC for
  responses.

---

## 1. DSL

### 1a. Declare a bus — Layer 1 (defaults, 5 lines)

```ts
// src/events/orders.bus.ts
import { bus } from '@syncengine/core';
import { z } from 'zod';

export const OrderEvent = z.enum(['created', 'paid', 'shipped', 'cancelled']);

export const orderEvents = bus('orderEvents', {
    schema: z.object({
        orderId: z.string(),
        event: OrderEvent,
        at: z.number(),
    }),
});
```

Defaults:
- 7-day retention, 1M-message cap
- File storage, single replica
- Fan-out delivery (every subscriber reads every event)
- 1-minute dedup window at publish time
- Auto-DLQ at `orderEvents.dlq`, 30-day retention
- Framework-managed durable consumers per subscriber

### 1b. Declare a bus — Layer 2 (typed presets)

```ts
import { bus, Retention, Delivery, Storage } from '@syncengine/core';
import { days, minutes } from '@syncengine/core/duration';

export const orderEvents = bus('orderEvents', {
    schema,
    retention: Retention
        .durableFor(days(90))
        .maxMessages(10_000_000)
        .discardOldest(),
    delivery: Delivery.fanout(),                         // or .queue() / .interest()
    storage: Storage.replicatedFile({ replicas: 3 }),    // or .memory() / .file()
    dedupWindow: minutes(5),
});
```

All of `Retention`, `Delivery`, `Storage` are typed factory
namespaces. `Retention.durable`, `Delivery.fanout`, `Storage.memory`
are accessors, not strings.

### 1c. Declare a bus — Layer 3 (full JetStream escape hatch)

```ts
import { JetStream } from '@syncengine/core/jetstream';

export const orderEvents = bus('orderEvents', {
    schema,
    jetstream: JetStream.stream({
        retention: JetStream.retention.limits,
        storage: JetStream.storage.file,
        maxAge: days(90),
        maxMsgs: 10_000_000,
        maxBytes: bytes.gib(50),
        maxMsgSize: bytes.mib(1),
        discard: JetStream.discard.old,
        numReplicas: 3,
        duplicateWindow: minutes(5),
        compression: JetStream.compression.s2,
        allowRollup: true,
        placement: JetStream.placement({
            cluster: 'east',
            tags: ['us-east-1'],
        }),
    }),
});
```

`JetStream.*` re-exports every NATS stream option as typed
enums / factories. `JetStream.retention.limits` is an accessor,
not `"limits"`. Numbers that represent dimensional values (age,
size) must come from `Duration` or `Bytes` factories — plain
numbers are rejected by the type.

**Layers compose.** Use Layer 2 and pass a `jetstream:` block for
just the knobs Layer 2 doesn't cover.

### 1d. Publish from an entity handler — the new effect

```ts
// src/entities/order.actor.ts
import { defineEntity, emit, insert, trigger, publish } from '@syncengine/core';
import { orderEvents, OrderEvent } from '../events/orders.bus';
import { processPayment } from '../workflows/process-payment.workflow';
import { notes } from '../schema';

const order = defineEntity('order', {
    state: { status: text({ enum: ['draft', 'pending_payment', 'paid', ...] }), ... },
    handlers: {
        place(state) {
            return emit({
                state: { ...state, status: 'pending_payment' as const },
                effects: [
                    insert(notes, { body: `Order $${state.total}` }),
                    trigger(processPayment, { orderKey: state.id }),
                    publish(orderEvents, {
                        orderId: state.id,
                        event: OrderEvent.placed,
                        at: Date.now(),
                    }),
                ],
            });
        },
    },
});
```

`publish(bus, payload)` returns an effect declaration. The entity
runtime executes it **after** state is persisted, inside a
`ctx.run` so Restate's replay is deterministic. Payload is
validated against the bus's schema; validation failure throws
`TerminalError`.

### 1e. Publish from a workflow / webhook / heartbeat — imperative

Orchestrators are already async and receive `ctx`. They use the
imperative form, same mental model as `ctx.services.payments.charge(...)`:

```ts
await orderEvents.emit(ctx, {
    orderId: input.id,
    event: OrderEvent.shipped,
    at: Date.now(),
});
```

Framework wraps the publish in `ctx.run` internally; caller doesn't.

### 1f. Subscribe — a workflow with `on:`

```ts
// src/workflows/ship.workflow.ts
import { defineWorkflow, on } from '@syncengine/server';
import { Retry, Backoff, TerminalError } from '@syncengine/core';
import { minutes, hours } from '@syncengine/core/duration';
import { orderEvents, OrderEvent } from '../events/orders.bus';
import { shipping, notifications } from '../services';

export const shipOnPay = defineWorkflow(
    'shipOnPay',
    {
        on: on(orderEvents)
            .where(e => e.event === OrderEvent.paid)
            .orderedBy(e => e.orderId)
            .concurrency(Concurrency.global(10)),
        services: [shipping, notifications],
        retry: Retry.exponential({ attempts: 10, initial: minutes(1), max: hours(1) }),
        timeout: minutes(15),
        dlq: orderEvents.dlq,
    },
    async (ctx, event) => {
        await ctx.services.shipping.create(event.orderId);
        await orderEvents.emit(ctx, {
            orderId: event.orderId,
            event: OrderEvent.shipped,
            at: Date.now(),
        });
    },
);
```

Subscribers are **ordinary workflows** — `defineWorkflow` with
an added `on:` option in the config block. `ctx.services`
injection works exactly like today. No new registrant, no new
ctx shape.

### 1g. `trigger()` vs `publish()` — decision matrix

| Effect | Use when | Coupling |
|---|---|---|
| `insert(table, record)` | Entity needs to record a side fact in a domain table. | Domain ↔ domain data |
| `trigger(workflow, input)` | Exactly one named workflow should run. Tight, direct coupling. | Entity → workflow |
| `publish(bus, event)` | Fan-out. Unknown / multiple / pluggable subscribers. Loose coupling. | Entity → bus → N subscribers |

`trigger()` stays in v1. It's cheaper than a bus round-trip for
the one-workflow case and explicit at the call-site about what
runs next. The two coexist.

---

## 2. Meteor-easy EDD patterns (the 90% case)

Every common pattern is ≤10 lines on the subscriber.

### 2a. Fan-out (default)

```ts
// Every subscriber reads every event.
export const X = bus('X', { schema });

defineWorkflow('subA', { on: on(X), services: [...] }, async (ctx, e) => { ... });
defineWorkflow('subB', { on: on(X), services: [...] }, async (ctx, e) => { ... });
// Both fire on every event.
```

### 2b. Work queue (competing consumers)

```ts
export const emailJobs = bus('emailJobs', {
    schema: EmailJob,
    delivery: Delivery.queue(),   // stream consumes on ack
});

defineWorkflow(
    'sendEmail',
    {
        on: on(emailJobs),
        services: [mail],
        concurrency: Concurrency.global(50),   // 50 workers compete
    },
    async (ctx, job) => { await ctx.services.mail.send(job); },
);
```

### 2c. Per-key ordered processing

```ts
on: on(orderEvents).orderedBy(e => e.orderId),
// One in-flight per orderId; distinct orders run in parallel.
```

### 2d. Replay-from-start (build a projection)

```ts
import { From } from '@syncengine/core';

defineWorkflow(
    'auditProjection',
    {
        on: on(orderEvents).from(From.beginning()),
        services: [audit],
    },
    async (ctx, event) => { await ctx.services.audit.append(event); },
);
```

`From.beginning()`, `From.latest()`, `From.sequence(n)`,
`From.time(isoOrDate)`.

### 2e. Rate limiting

```ts
on: on(orderEvents),
rate: Rate.perSecond(100),          // or Rate.perMinute, Rate.perHour
```

### 2f. Idempotency key

```ts
on: on(orderEvents).key(e => `${e.orderId}:${e.event}`),
// Framework dedups Restate invocations by this key across redeliveries.
```

### 2g. Retry → DLQ → alert (auto-DLQ)

```ts
defineWorkflow(
    'alertOnShippingFailure',
    {
        on: on(orderEvents.dlq),   // the auto-DLQ, subscribed like any other bus
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

### 2h. Compensating saga on failure

```ts
{
    on: on(orderEvents).where(e => e.event === OrderEvent.paid),
    services: [shipping, payments],
    async run(ctx, event) {
        try {
            await ctx.services.shipping.create(event.orderId);
        } catch (err) {
            // Compensate: refund + announce cancellation.
            await ctx.services.payments.refund(event.chargeId);
            await orderEvents.emit(ctx, {
                orderId: event.orderId,
                event: OrderEvent.cancelled,
                at: Date.now(),
            });
            throw new TerminalError('shipping failed, refunded', { cause: err });
        }
    },
}
```

### 2i. Terminal error (don't retry — go straight to DLQ)

```ts
async (ctx, event) => {
    try {
        await ctx.services.payments.charge(event);
    } catch (err) {
        if (err instanceof FundsInsufficientError) {
            throw new TerminalError('do not retry', { cause: err });
        }
        throw err;     // everything else retriable
    }
}
```

### Litmus table

| Task | Lines |
|---|---|
| Declare a bus | 5 |
| Emit from an entity | 1 (add `publish(...)` to effects) |
| Subscribe to paid orders, run shipping | 7 |
| Fan-out to 3 subscribers | 3× a subscribe block |
| Work-queue email jobs, 50 workers | 10 |
| Replay all events into a projection | 7 |
| Auto-DLQ with Slack alert | 7 |
| Per-key ordered processing | +1 line |
| Compensating saga on failure | the try/catch you'd already write |

---

## 3. Retry, timeout, DLQ

### 3a. Defaults

| Concern | Default |
|---|---|
| Retry attempts | 3 |
| Backoff | `Backoff.exponential({ initial: seconds(1), max: minutes(1) })` |
| Timeout per attempt | `minutes(5)` |
| DLQ | Auto — `<bus>.dlq` (same schema), `days(30)` retention |
| Dedup key | `<busName>:<seq>` |

### 3b. Overrides

```ts
retry: Retry.exponential({ attempts: 10, initial: minutes(1), max: hours(1) }),
// or Retry.fixed({ attempts: 5, interval: seconds(30) })
// or Retry.none()     — go straight to DLQ on first failure
timeout: minutes(15),
dlq: shippingFailures, // typed bus ref, or `false` to disable
```

### 3c. `TerminalError` semantics

Throwing `TerminalError` from the handler bypasses retry, skips
to the DLQ with `attempts = current`. For domain refusals
(`INSUFFICIENT_FUNDS`) that won't resolve with more tries.

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
    readonly workflow: string;
}
```

### 3e. Auto-DLQ vs named DLQ

```ts
// Auto — nothing to configure
bus.dlq        // typed BusRef<DeadEvent<T>>

// Named / shared
export const criticalFailures = bus('criticalFailures', {
    schema: DeadEvent.of(orderEvents),   // framework derives
    retention: Retention.durableFor(days(90)),
});

dlq: criticalFailures,
```

---

## 4. Testing via `override()`

Same mechanism users learned for services:

```ts
// src/events/test/orders.ts
import { override } from '@syncengine/core';
import { BusMode } from '@syncengine/core';
import { orderEvents } from '../orders.bus';

export default override(orderEvents, {
    mode: BusMode.inMemory(),  // no NATS, synchronous delivery, capturable
});
```

Wired through `syncengine.config.ts`:

```ts
services: {
    overrides: process.env.NODE_ENV === 'test'
        ? () => import('./events/test')
        : undefined,
},
```

Test-mode semantics:
- `publish()` + `bus.emit(ctx, ...)` go to an in-memory ring buffer.
- Subscribers fire synchronously within the same task.
- Assertions run inline: `expect(harness.dispatchedFor('shipOnPay')).toHaveLength(1)`.
- DLQ + retry semantics work identically — `TerminalError` still lands in `bus.dlq`.

Use cases:
- Unit test an entity's `publish()` without a NATS dependency.
- Integration test a subscriber's compensating saga with a fake
  `payments.refund` via the existing service override.
- E2E test without spinning up the Docker stack.

---

## 5. Delivery + processing guarantees

```
┌───────────┐     NATS JetStream       ┌────────────┐
│ publish() │────────────────────────▶ │ Consumer   │
│ or        │    subject:              │ (durable,  │
│ bus.emit()│    ws.<wsId>.bus.<name>  │  per sub)  │
└───────────┘                          └─────┬──────┘
                                             │
                                             ▼
                                   ┌─────────────────┐
                                   │ Restate         │
                                   │ workflow        │
                                   │ invocation,     │
                                   │ id =            │
                                   │ <bus>:<seq> or  │
                                   │ .key(fn)(event) │
                                   └─────────────────┘
```

- **At-least-once** from JetStream to the dispatcher.
- **Effective-exactly-once processing** via Restate's
  invocation-id dedup. The framework derives the invocation id
  from `<busName>:<seq>` (or from `.key(fn)` when provided) so
  redelivered messages idempotent-merge into the existing
  invocation.
- **Workflow completion** → `ack` → message evictable under the
  retention policy.
- **Retries exhausted** → publish to `<bus>.dlq` → `ack` the
  original.

---

## 6. Scope & ordering

```ts
on: on(orderEvents)
    .where(e => e.event === OrderEvent.paid)
    .orderedBy(e => e.orderId)
    .concurrency(Concurrency.global(10))
    .rate(Rate.perSecond(100))
    .from(From.latest()),
```

| Modifier | Semantics |
|---|---|
| `.where(fn)` | Server-side filter; predicate runs before Restate invocation. |
| `.ordered()` | Single in-flight invocation for this subscriber. |
| `.orderedBy(fn)` | One in-flight per `fn(event)` key; distinct keys parallel. |
| `.key(fn)` | Dedup key beyond framework default. |
| `.concurrency(Concurrency.global(n))` | Global cap. |
| `.concurrency(Concurrency.perKey(n))` | Per-partition cap (pairs with `.orderedBy`). |
| `.rate(Rate.perSecond(n))` | Token bucket. Also `.perMinute` / `.perHour`. |
| `.from(From.beginning() / .latest() / .sequence(n) / .time(d))` | Initial cursor for durable consumer. |

Implementation: `.orderedBy(fn)` compiles to a Restate virtual
object keyed by `fn(event)` — Restate's single-writer per key
gives the serialisation for free. `.ordered()` is
`.orderedBy(() => 'singleton')`.

---

## 7. Cross-tier behaviour

Buses emit + subscribe from any **server-side** tier:

- `syncengine start` (single-process) — both in the same Node
  process.
- `syncengine serve` scale-out — edge can `emit()`
  (operational events, health signals); subscribers register on
  handlers.
- Both tiers use `gateway-core`'s `connectNats()` so the ws://
  vs nats:// URL split is handled.

Subscribers only run on the **handlers** tier (they register
with Restate).

---

## 8. Hex walls

Enforced structurally — no lint rules.

**Wall 1: Entities publish declaratively, not imperatively.**
Entity handler signature is
`(state, ...args) => TState | EmitResult<TState>`. No `ctx`,
no `async`, no `Promise`. `publish(bus, payload)` is an effect
**declaration**; execution happens in the runtime.

**Wall 2: Workflows see port types, not vendor SDKs.**
`ctx.services.payments` is the `PaymentsPort` interface
extracted from the service definition.

**Wall 3: Subscribers are workflows.**
No "bus subscriber" primitive exists separately. A subscriber IS
a workflow with `on:` — so everything the workflow primitive
enforces (services injection, Restate durability, handler
signatures) applies unchanged.

**Wall 4: `publish()` + `emit()` payloads are serialisable.**
Schema is zod-checked at publish time; NATS publish serialises
to JSON.

---

## 9. Implementation sketch

### 9a. Package layout

| Package | Responsibility |
|---|---|
| `@syncengine/core` | `bus()` DSL, `publish()` effect, `Retention` / `Delivery` / `Storage` / `Retry` / `Backoff` / `Rate` / `Concurrency` / `From` / `BusMode` factories, `DeadEvent<T>` type. |
| `@syncengine/core/duration` | Typed `Duration` + `Bytes` factories (existing). |
| `@syncengine/core/jetstream` | Layer 3 escape hatch — typed re-exports of every JetStream option. |
| `@syncengine/server` | `on()` fluent builder, `defineWorkflow` accepts `on:`, dispatcher that maps NATS messages → Restate invocations. |
| `@syncengine/gateway-core` | NATS/JetStream plumbing already exists; dispatcher reuses `connectNats()` + stream setup. |
| `@syncengine/vite-plugin` | `.bus.ts` discovery, manifest emission, dev dispatcher spin-up. Also discovers `events/test/` / `events/staging/` overrides. |
| `@syncengine/cli` | `syncengine add bus <name>` generator; `init` scaffolds `src/events/`. |

### 9b. Manifest

```jsonc
{
  "buses": [
    {
      "name": "orderEvents",
      "path": "src/events/orders.bus.ts",
      "retention": { "maxAge": 7776000000, "maxMessages": 10000000, "discard": "old" },
      "delivery": { "mode": "fanout" },
      "storage": { "kind": "file", "replicas": 3 },
      "dedupWindow": 300000,
      "jetstream": { /* resolved after layer merge */ }
    }
  ],
  "subscribers": [
    {
      "workflowName": "shipOnPay",
      "path": "src/workflows/ship.workflow.ts",
      "busName": "orderEvents",
      "filter": "<serialised>",
      "ordering": { "kind": "byKey", "keyFn": "<serialised>" },
      "concurrency": { "kind": "global", "n": 10 },
      "retry": { "kind": "exponential", "attempts": 10, "initial": 60000, "max": 3600000 },
      "timeout": 900000,
      "dlq": "orderEvents.dlq",
      "from": { "kind": "latest" }
    }
  ]
}
```

### 9c. Dispatcher

One long-running coroutine per subscriber inside the handlers
container:

1. Open a durable JetStream consumer named
   `<workspaceHash>:bus:<busName>:<workflowName>`.
2. Pull messages, run `.where` filter, derive invocation id
   (`<bus>:<seq>` or `<bus>:.key(fn)(event)`).
3. `POST /workflow_<name>/<invocationId>/run` against Restate
   ingress.
4. On non-terminal failure: nak with backoff.
5. On exhaustion: publish to `<bus>.dlq`, ack the original.
6. On success: ack.

### 9d. Determinism

```ts
// Both entity effect AND workflow imperative call compile to:
const seq = await ctx.run(`bus:${name}:emit`, async () => {
    const pub = await nc.publish(subject, JSON.stringify(payload));
    return pub.seq;
});
```

Restate journals the `seq`; replays reuse it, preserving the
invocation-id dedup chain.

### 9e. Bus reconciliation

`syncengine build` emits the manifest. At server boot the
framework reconciles each bus's declared JetStream config against
the cluster's actual stream state (idempotent `jsm.streams.update`).
Same cadence `heartbeat` status entities already use.

---

## 10. Devtools

A new **Buses** tab:

- Live-tail every bus in the current workspace. Click a message
  → payload inspector + list of subscriber invocations.
- Subscriber table per bus: status (healthy / backlogged /
  exhausted), last-ack seq, in-flight count, DLQ count.
- DLQ inspector: per-dead-event row. Actions: re-emit, copy
  payload, mark archived.
- Subject-tree view (optional) for power users.
- Jetstream stream inspector: show the reconciled stream config
  with a diff from the declared `bus()` options.

---

## 11. Success criteria

1. A 30-line `bus()` + `defineWorkflow({ on, services })` pair
   works against `apps/notepad` without importing NATS, Restate
   SDK, or JetStream.
2. `syncengine start` and `syncengine serve` both support emit +
   subscribe without config changes. Same code runs both.
3. All nine EDD patterns in §2 work with the line counts
   claimed in the litmus table.
4. Poison events land in the DLQ after declared attempts, show
   in devtools, re-emittable in one click.
5. `override()` with `BusMode.inMemory()` swaps in a synchronous
   in-memory dispatcher — subscriber assertions run inline with
   no NATS dependency in tests.
6. Types flow end-to-end: `on(bus).where(e => ...)` narrows `e`
   to the zod-inferred shape; `defineWorkflow(..., async (ctx,
   event) => {...})` gets the same; `ctx.services` is typed to
   the declared services' ports.
7. Workspace deletion wipes bus streams, consumer state, and
   DLQ entries.
8. Layer 2 → Layer 3 option merge: declaring both
   `retention: Retention.durableFor(days(90))` AND a
   `jetstream: { compression: ... }` block produces a JetStream
   stream with both applied; conflicts throw at build time with
   a pointer to the offending field.

---

## 12. Open questions

- **Verb.** `publish(bus, event)` for the effect, `bus.emit(ctx,
  event)` for the imperative call. The symmetry breaks slightly
  — `publish` doesn't match `emit` elsewhere. Candidate: unify
  as `publish()` + `bus.publish(ctx, event)`. Worth revisiting
  before code lands. Lean toward the unified form.
- **`trigger()` longevity.** With `publish()` + fan-out, the
  tight-coupled `trigger()` case becomes a one-subscriber bus.
  Spec keeps both for v1. Re-evaluate after the demo settles:
  if `trigger` turns out to be redundant, plan a deprecation
  path.
- **Multi-bus subscribers.** `on(busA, busB)` — interesting for
  projections that merge streams. First pass: one bus per
  subscriber. Revisit if the demo surfaces a clean use case.
- **Priority / weighted rate.** Not in v1.
- **Pause / disable without deploy.** Devtools toggle to park a
  consumer without killing the workflow. Phase 3.
- **Cross-workspace.** Explicit non-goal v1; operator-level
  fan-in needs its own spec.

---

## 13. Phased delivery

### Phase 1 — Primitive + hex integration (~1 week)

- `bus()` DSL — Layer 1 defaults + Layer 2 typed presets.
- `publish()` as a third effect in `emit({ effects })`.
- `bus.emit(ctx, ...)` imperative form for workflows / webhooks
  / heartbeats.
- `on()` fluent builder — `.where`, `.from`.
- `defineWorkflow` accepts `on:` + services injection for
  subscribers.
- Default retry + auto-DLQ (`<bus>.dlq`).
- CLI: `syncengine add bus <name>`; `init` scaffolds
  `src/events/`.
- Manifest + dispatcher in handlers tier.
- Smoke: extend `apps/notepad` — entity publishes `OrderPaid`,
  one subscriber runs shipping via `ctx.services.shipping`.

### Phase 2 — DX hardening

- Layer 3 escape hatch (`JetStream.*` typed options).
- `.orderedBy`, `.ordered`, `.concurrency`, `.rate`, `.key`.
- `Retry.*` / `Backoff.*` fluent factories.
- `BusMode.inMemory()` for tests; `override()` wiring.
- Devtools **Buses** tab.

### Phase 3 — Cross-tier + operational

- Scale-out compose smoke: emit from edge, handler consumes.
- Workspace teardown wipes bus streams + DLQs.
- Pause / re-emit controls in devtools.
- Load bench vs the Node bundle baseline.

### Phase 4 — Future work (separate specs)

- `feed()` — curated client-facing streams derived from buses.
- External transport adapters (Kafka / Redis Streams).
- Cross-workspace fan-in.
- Schema evolution tooling.
