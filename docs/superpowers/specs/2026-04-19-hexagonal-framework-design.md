# Hexagonal Architecture Framework for syncengine

**Date:** 2026-04-19
**Status:** Draft

## Context

syncengine targets Meteor-like DX for real-time sync apps. The framework already nails the "driving" half of the hexagon — React hooks (`useStore`, `useEntity`), webhooks, heartbeats all drive pure domain logic (tables, entities, views). What's missing is the "driven" half: a structured way for domain logic to reach external services (Stripe, SendGrid, shipping APIs, etc.) without coupling domain code to vendor SDKs.

**Pain points:**
1. **Side effects are unstructured** — workflows/webhooks `fetch()` inline, untestable spaghetti
2. **No shared vocabulary for app structure** — every syncengine app organizes differently
3. **External integrations leak into domain logic** — vendor SDKs imported directly in orchestration code

**Approach:** Hybrid `service()` with extractable ports — one file per service in the common case, framework auto-extracts port types, override path for test/staging environments. Type-enforced hex walls via function signatures, not lint rules.

---

## 1. Directory Structure & Conventions

The framework enforces this layout. The CLI scaffolds it, the Vite plugin discovers files by convention.

```
src/
  schema.ts              <- tables, views, columns (pure domain data)
  db.ts                  <- store({ tables, views })

  entities/
    order.actor.ts       <- defineEntity() -- pure state machines
    inventory.actor.ts

  services/
    payments.ts          <- service('payments', { ... })
    shipping.ts          <- service('shipping', { ... })
    notifications.ts     <- service('notifications', { ... })
    test/                <- override() files, auto-excluded from prod builds
      payments.ts
      shipping.ts
    staging/             <- optional staging overrides
      payments.ts

  workflows/
    process-order.workflow.ts    <- orchestration, receives ctx.services
    fulfill-order.workflow.ts

  webhooks/
    stripe-events.webhook.ts    <- inbound, receives ctx.services
    shippo-tracking.webhook.ts

  heartbeats/
    sync-inventory.heartbeat.ts <- scheduled, receives ctx.services

  topics/
    presence.topic.ts           <- ephemeral pub/sub (unchanged)

  app/                          <- React components (driving adapter)
    App.tsx
```

**Rules:**
- `schema.ts`, `entities/` — pure domain. No imports from `services/`.
- `services/` — boundary with outside world. Can import vendor SDKs.
- `workflows/`, `webhooks/`, `heartbeats/` — orchestration layer. Imports domain + services.
- `app/` — React UI. Uses `useStore()`, `useEntity()`. Doesn't import services directly.

**Discovery:** Vite plugin auto-discovers `services/*.ts` the same way it discovers `*.actor.ts` today. Files in `services/test/` and `services/staging/` are excluded from production bundles.

---

## 2. The `service()` Primitive

New export from `@syncengine/core`. Declares a typed bag of async methods wrapping an external integration.

```ts
// services/payments.ts
import Stripe from 'stripe';
import { service } from '@syncengine/core';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export const payments = service('payments', {
  async charge(amount: number, currency: string) {
    const charge = await stripe.charges.create({ amount, currency });
    return { id: charge.id, status: charge.status };
  },

  async refund(chargeId: string) {
    const refund = await stripe.refunds.create({ charge: chargeId });
    return { id: refund.id, status: refund.status };
  },
});
```

**What `service()` returns:** A `ServiceDef<Name, Methods>` — an opaque definition (same pattern as `table()`, `defineEntity()`). Carries:
- The name (for discovery, injection, and override matching)
- The implementation (the default adapter)
- The inferred port type (method signatures only, no vendor types)

**Constraints:**
- All methods must be `async` (services are inherently I/O)
- Arguments and return types must be serializable (Restate journals calls)
- No `this` — methods are pure functions (individually overridable)

**Anti-corruption layer:** Return types are YOUR domain types, not vendor types. `{ id: string, status: string }`, not `stripe.Charge`. If Stripe changes their API, only this file changes.

---

## 3. `emit()` Redesign — Entity -> Workflow Bridge

Entity handlers stay pure. When they need side effects, they use `emit()` to declare effects alongside state changes. Effects are an unordered bag, not a sequence.

```ts
// entities/order.actor.ts
import { defineEntity, emit, insert, trigger } from '@syncengine/core';
import { processPayment } from '../workflows/process-payment.workflow';
import { notes } from '../schema';

const order = defineEntity('order', {
  state: {
    status: text({ enum: ['draft', 'pending_payment', 'paid', 'shipped', 'cancelled'] }),
    total: integer(),
    customerEmail: text(),
  },

  transitions: {
    draft:           ['pending_payment', 'cancelled'],
    pending_payment: ['paid', 'cancelled'],
    paid:            ['shipped'],
    shipped:         [],
    cancelled:       [],
  },

  handlers: {
    place(state) {
      return emit({
        state: { ...state, status: 'pending_payment' as const },
        effects: [
          insert(notes, { body: `Order placed: $${state.total}` }),
          trigger(processPayment, { total: state.total, email: state.customerEmail }),
        ],
      });
    },

    // Simple case -- no effects, no emit, unchanged from today
    confirmPayment(state) {
      return { ...state, status: 'paid' as const };
    },

    cancel(state) {
      return { ...state, status: 'cancelled' as const };
    },
  },
});
```

**`emit()` API:**
- Single call, one object: `{ state, effects }`
- `state` and `effects` are named peers — no sequential implication
- `effects` is an array (unordered bag of declarations)
- Helper functions: `insert(table, record)`, `trigger(workflow, input)` — type-checked
- Simple handlers (no effects) just return state as today

**Execution order (framework-controlled):**
1. Persist entity state (always first)
2. Execute all effects after state is committed (no guaranteed order between effects)
3. Workflow triggers are async — entity handler has already returned

**Saga pattern this enables:**

```
  place()                processPayment workflow
    |                         |
    +- status -> pending      |
    +- emit({ trigger })------+
    |                         +- ctx.services.payments.charge()
    |                         |    +- success -> entity.confirmPayment()
    |                         |    +- failure -> entity.cancel()
    v                         v
  (pure, sync, done)    (async, durable, retryable)
```

---

## 4. Service Injection into Workflows, Webhooks, Heartbeats

Services are declared as dependencies and injected into the `ctx` parameter.

```ts
// workflows/process-payment.workflow.ts
import { defineWorkflow } from '@syncengine/server';
import { payments } from '../services/payments';
import { notifications } from '../services/notifications';
import { order } from '../entities/order.actor';
import { entityRef } from '@syncengine/server';

export const processPayment = defineWorkflow(
  'processPayment',
  { services: [payments, notifications] },
  async (ctx, input: { total: number; email: string; orderKey: string }) => {
    // ctx.services typed as { payments: PaymentsPort, notifications: NotificationsPort }
    const charge = await ctx.services.payments.charge(input.total, 'usd');

    const ref = entityRef(ctx, order, input.orderKey);

    if (charge.status === 'succeeded') {
      await ref.confirmPayment();
      await ctx.services.notifications.send(input.email, 'Payment confirmed');
    } else {
      await ref.cancel();
      await ctx.services.notifications.send(input.email, 'Payment failed');
    }
  },
);
```

**Same pattern for webhooks and heartbeats:**

```ts
// webhooks/stripe-events.webhook.ts
export const stripeEvents = webhook('stripeEvents', {
  services: [notifications, shipping],
  path: '/stripe',
  verify: { scheme: 'hmac-sha256', secret: () => process.env.STRIPE_WEBHOOK_SECRET! },
  run: async (ctx, payload) => {
    // ctx.services.notifications, ctx.services.shipping available
  },
});

// heartbeats/sync-inventory.heartbeat.ts
export const syncInventory = heartbeat('syncInventory', {
  services: [inventory],
  every: '5m',
  run: async (ctx) => {
    // ctx.services.inventory available
  },
});
```

**Key properties:**
- Explicit dependency declaration — `{ services: [...] }` lists what's needed
- Port-typed context — workflows see the interface, not the Stripe SDK
- Compile-time error if you access an undeclared service
- Entity handlers do NOT get `ctx.services` — enforced by handler signature type

---

## 5. Service Overrides — Testing & Environment Variants

```ts
// services/test/payments.ts
import { override } from '@syncengine/core';
import { payments } from '../payments';

export default override(payments, {
  async charge(amount, currency) {
    return { id: 'test_ch_123', status: 'succeeded' };
  },
  async refund(chargeId) {
    return { id: 'test_re_123', status: 'succeeded' };
  },
});
```

**Override is total by default** — must implement every method. TypeScript enforces completeness. Partial override opt-in:

```ts
export default override(payments, {
  async charge() { return { id: 'test_ch_123', status: 'succeeded' }; },
}, { partial: true });  // other methods use real implementation
```

**Wiring in config:**

```ts
// syncengine.config.ts
export default defineConfig({
  services: {
    overrides: process.env.NODE_ENV === 'test'
      ? () => import('./services/test')
      : undefined,
  },
});
```

The `services/test/` directory is a barrel — each file exports a default override, matched to services by name.

**Multiple environments:**

```ts
services: {
  overrides:
    process.env.NODE_ENV === 'test'    ? () => import('./services/test') :
    process.env.NODE_ENV === 'staging' ? () => import('./services/staging') :
    undefined,
},
```

---

## 6. Type Enforcement — How the Hex Walls Work

No lint rules or build-time import scanning. Walls are structural.

**Wall 1: Entity handlers can't access services.**
Handler signature is `(state, ...args) => TState | Partial<TState> | EmitResult<TState>`. No `ctx`, no `async`, no `Promise` return. Impossible to call services from here.

**Wall 2: Workflows only see port types.**
`ctx.services.payments` resolves to `PaymentsPort` (extracted interface), not the concrete Stripe implementation. Vendor SDK internals don't leak.

**Wall 3: Serializable boundaries.**
Service method args and returns must be JSON-serializable (Restate journals calls). This forces the anti-corruption pattern — translate vendor types into domain types at the service boundary.

**Wall 4: `emit()` effects are type-checked.**
`trigger()` validates workflow input types. `insert()` validates table column types. TypeScript catches mismatches at compile time.

**What's NOT enforced (by design):**
A developer *could* `import Stripe from 'stripe'` in a workflow and call it directly. The type system doesn't block this. But it's pointless when `ctx.services.payments` is right there — typed, testable, and journaled. The easy path IS the right path.

---

## 7. CLI Scaffolding & Discovery

**`syncengine init` generates the hex structure:**

```
src/
  schema.ts
  db.ts
  entities/
    counter.actor.ts
  services/
    .gitkeep
  workflows/
    .gitkeep
  webhooks/
    .gitkeep
  heartbeats/
    .gitkeep
  topics/
    .gitkeep
  app/
    App.tsx
syncengine.config.ts
```

**`syncengine add service <name>` generator:**

```
$ syncengine add service payments
Created: src/services/payments.ts
```

**Vite plugin discovery (extends existing pattern):**
- `services/*.ts` — service definitions (default adapters)
- `services/test/*.ts` — test overrides (excluded from prod build)
- `services/staging/*.ts` — staging overrides (excluded from prod build)

**Dev server startup log includes services:**

```
  syncengine dev

  > schema     2 tables, 4 views
  > entities   order, inventory
  > services   payments, shipping, notifications
  > workflows  processPayment, fulfillOrder
  > webhooks   stripeEvents
  > heartbeats syncInventory
  > nats       localhost:4222
  > restate    localhost:9080
  > gateway    ws://localhost:4280
  > app        http://localhost:5173
```

---

## Files to Create/Modify

### New files:
- `packages/core/src/service.ts` — `service()`, `override()`, `ServiceDef`, `ServicePort<T>` types
- `packages/core/src/emit.ts` — `emit()`, `insert()`, `trigger()`, `EmitResult` type
- `packages/server/src/service-container.ts` — service registry, instantiation, override resolution, injection
- `packages/vite-plugin/src/services.ts` — service discovery sub-plugin
- `packages/cli/src/add.ts` — `syncengine add service` generator

### Modified files:
- `packages/core/src/index.ts` — re-export service and emit primitives
- `packages/core/src/entity.ts` — update handler return type to accept `EmitResult`
- `packages/core/src/config.ts` — extend `SyncengineConfig` with `services.overrides`
- `packages/server/src/entity-runtime.ts` — parse `EmitResult`, execute effects after state persist
- `packages/server/src/workflow.ts` — accept `services` option in `defineWorkflow`, inject into ctx
- `packages/server/src/webhook.ts` — accept `services` option, inject into ctx
- `packages/server/src/heartbeat.ts` — accept `services` option, inject into ctx
- `packages/vite-plugin/src/index.ts` — compose services plugin into plugin array
- `packages/cli/src/init.ts` — update scaffold to include hex directory structure

---

## Future Phases (not in this spec)

- **Test runtime** — `syncengine test` boots in-memory stack, auto-stubs services from port types
- **Service composition** — services that depend on other services
- **Event bus** — typed domain events as an alternative to `emit({ trigger })` for complex choreography
- **Service health checks** — framework pings services on startup, reports status in dev log
- **Service metrics** — automatic latency/error tracking per service method

---

## Verification

1. **Type safety**: Write a test service, workflow, and entity. Verify that:
   - Entity handler cannot accept `ctx` or return `Promise` (TS error)
   - Workflow accessing undeclared service errors at compile time
   - `trigger()` with wrong input type errors at compile time
   - Override with missing method errors at compile time

2. **Runtime**: Boot `syncengine dev` with a test service. Verify:
   - Service appears in startup log
   - Workflow receives injected service via ctx
   - Override swaps correctly when `NODE_ENV=test`
   - `emit({ trigger })` from entity handler starts workflow after state persists

3. **Scaffolding**: Run `syncengine init` and `syncengine add service payments`. Verify generated files match expected structure.

4. **Existing tests**: Run full test suite — none of the existing primitives (tables, entities, views, topics, workflows, webhooks, heartbeats) should break.
