# Workflows Guide

> `defineWorkflow()` is durable orchestration on Restate. Stateful
> choreography across entities, services, and external APIs —
> with automatic crash recovery, replay deduplication, and step-
> level retries baked in.

## When to reach for a workflow

| Primitive | Shape | Use for |
|---|---|---|
| `entity` | Pure handlers, keyed | Atomic mutations on one object. |
| `webhook` | HTTP in → run once | Inbound vendor callbacks. |
| `heartbeat` | Recurring schedule | Cron-like periodic work. |
| **`workflow`** | **Async body with durable ctx** | **Multi-step sagas across entities + external systems.** |

A workflow runs as a Restate invocation — body resumes from the journal on any crash. Every `await ctx.run(...)` checkpoints; every `entityRef(ctx, ...).method()` journals.

## Five-line declaration

```ts
// src/workflows/checkout.workflow.ts
import { defineWorkflow, entityRef } from '@syncengine/server';
import { inventory } from '../entities/inventory.actor';
import { order } from '../entities/order.actor';

export const checkout = defineWorkflow('checkout', async (ctx, input: {
  userId: string; orderId: string; productSlug: string; price: number; timestamp: number;
}) => {
  const inv = entityRef(ctx, inventory, input.productSlug);
  const ord = entityRef(ctx, order, input.orderId);

  await inv.sell(input.userId, input.orderId, input.price, input.timestamp);
  try {
    await ord.place(input.userId, input.productSlug, input.price, input.timestamp);
  } catch (err) {
    await inv.releaseReservation(input.userId);      // compensation
    throw err;
  }
});
```

Drop under `src/workflows/` with a `.workflow.ts` suffix — vite plugin picks it up, Restate registers `workflow_checkout` at boot.

## The ctx contract

Workflow handlers receive a Restate `WorkflowContext`. The framework adds:

| Field | When | What |
|---|---|---|
| `ctx.services.<name>` | Always | Typed service-port bag inferred from `services: [...]` declaration. |
| `ctx.run(name, fn)` | Always | Journal a non-deterministic step. Crashes resume from the journal. |
| `ctx.sleep(ms)` | Always | Durable sleep — survives process restarts. |
| `ctx.date.now()` | Always | Deterministic timestamp — same value on replay. |
| `entityRef(ctx, entity, key)` | Always | Typed proxy over entity handlers; each call journals. |

**Determinism is the rule.** The workflow body re-runs from the journal on crash; every journal read must produce the same value. Any network or filesystem I/O — external APIs, DB reads, file reads, `Date.now`, `Math.random` — must live inside a `ctx.run('step-name', async () => ...)` step so the result is journaled and replayed instead of re-executed. `ctx.run` is syncengine's "step" primitive: first run writes the result to the journal; replay reads from the journal.

```ts
// ❌ bricks replay — the SDK call runs again on crash/resume and
//    likely produces a different value (different charge id, etc.)
const charge = await stripe.charges.create({ amount: 1000 });

// ✅ journaled step — first run writes the result; replay reuses it
const charge = await ctx.run('stripe:charge', async () =>
  stripe.charges.create({ amount: 1000 }),
);

// ✅ or through a service (tests can swap stripe out for free) —
//    the ctx.services call isn't auto-journaled; wrap in ctx.run
const charge = await ctx.run('stripe:charge', async () =>
  ctx.services.payments.charge(1000),
);
```

## Dependency injection via `services`

Hex architecture: the workflow names typed ports, the framework injects concrete adapters at boot.

```ts
import { defineWorkflow, on } from '@syncengine/server';
import { shipping } from '../services/shipping';

export const shipOnPay = defineWorkflow(
  'shipOnPay',
  {
    on: on(orderEvents).where((e) => e.event === 'paid'),
    services: [shipping],
  },
  async (ctx, event) => {
    await ctx.services.shipping.create(event.orderId);
  },
);
```

`ctx.services.shipping.create` is fully typed — `ServicesOf<T>` maps the declared tuple to `{ [$name]: ServicePort<T> }` automatically. See `docs/guides/services.md`.

## Subscriber workflows

Pass `on: on(bus)` and the workflow becomes a bus subscriber. The framework opens a durable JetStream consumer per `(workspace × subscriber)` and routes every matching event to a Restate invocation.

```ts
defineWorkflow('auditOrder', {
  on: on(orderEvents).orderedBy((e) => e.orderId),  // serialise per orderId
}, async (_ctx, event) => {
  console.log('[audit]', event);
});
```

Full subscription DSL (`.where`, `.ordered`, `.orderedBy`, `.key`, `.concurrency`, `.rate`, `.from`) is documented in `docs/guides/event-bus.md`.

## Starting a workflow from code

**Fire-and-forget from a browser:**
```tsx
const s = useStore<DB>();
await s.startWorkflow(checkout, {
  userId: 'alice',
  orderId: 'O1',
  productSlug: 'widget',
  price: 10,
  timestamp: Date.now(),
});
```

**From another workflow / entity handler:**
Not supported directly — use a bus publish or `entityRef` depending on whether you want the downstream to be decoupled (bus) or synchronous and typed (entityRef).

## Common pattern: saga with compensation

```ts
export const checkout = defineWorkflow('checkout', async (ctx, input) => {
  const inv = entityRef(ctx, inventory, input.productSlug);
  const ord = entityRef(ctx, order, input.orderId);
  const payment = ctx.services.payments;

  await inv.reserve(input.userId, input.price, input.timestamp);
  let charged: { id: string } | null = null;
  try {
    charged = await ctx.run('payments:charge', async () =>
      payment.charge(input.price),
    );
    await ord.place(input.userId, input.productSlug, input.price, input.timestamp);
  } catch (err) {
    if (charged) await ctx.run('payments:refund', () => payment.refund(charged!.id));
    await inv.releaseReservation(input.userId);
    throw err;
  }
});
```

Each `ctx.run` is idempotent on replay — the first execution's result is journaled and reused.

## Testing

For non-bus workflows: call the handler directly with a mock ctx. `ctx.services` is populated from the `services: [...]` tuple, so the test just needs to construct matching service definitions or overrides.

For **bus-subscriber** workflows, use the harness:

```ts
import { createBusTestHarness } from '@syncengine/server/test';

const harness = createBusTestHarness({
  workflows: [shipOnPay],
  services: [shipping],
});

await orderEvents.publish(harness.ctx(), { orderId: 'O1', event: 'paid', at: 0 });
expect(harness.dispatchedFor(shipOnPay)).toHaveLength(1);
```

The harness routes publishes through the same seam as production, fires subscribers inline, and routes `TerminalError` to `<bus>.dlq` with `DeadEvent<T>` the same way the dispatcher does. See `docs/guides/testing.md`.

## Footguns

- **Non-determinism breaks replay.** `Date.now()`, `Math.random()`, `fs.readFileSync(...)`, any unjournaled external-API call — all produce different values on crash-and-resume. Use `ctx.date.now()`, wrap I/O in `ctx.run('step', async () => ...)`, and pass random/user input as args.
- **Workflow names must be unique across the app.** The framework registers `workflow_<name>` at Restate boot; duplicates throw.
- **`trigger()` is deprecated** — Phase 1 of the event-bus epic replaced it with `publish()` on a bus. See `docs/migrations/2026-04-20-trigger-to-publish.md`.
- **`ctx.run` is required for any non-deterministic I/O**, including DB reads if the result can change between calls. The framework doesn't auto-wrap.

## Pairs with

- **Entities** via `entityRef(ctx, entity, key)` — durable, typed RPC.
- **Services** via `ctx.services.<name>` — hex adapters for vendor SDKs and business logic.
- **Bus** via `on: on(bus)` — event-driven workflow invocation; or `await bus.publish(ctx, ...)` inside the body for imperative emits.
- **Webhooks + heartbeats** — they're both workflows internally, so the ctx contract is the same.

## Links

- Spec: `docs/superpowers/specs/2026-04-13-entity-ref-workflow-design.md`
- Server code: `packages/server/src/workflow.ts`
- Entity-ref proxy: `packages/server/src/entity-ref.ts`
- Demo: `apps/kitchen-sink/src/workflows/checkout.workflow.ts`, `ship-on-pay.workflow.ts`
