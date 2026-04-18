# Services Guide

> `service()` declares a driven port in hex architecture — a typed
> method bag the framework injects into workflows, webhooks, and
> heartbeats. The port interface is all your business logic sees;
> the implementation is swappable (real in prod, stub in tests).

## When to reach for a service

| Primitive | Shape | Use for |
|---|---|---|
| `entity` | State + handlers | Domain objects you own. |
| **`service`** | **Typed method bag (driven port)** | **Vendor SDKs, HTTP APIs, anything with I/O that isn't an entity.** |

If the implementation reaches outside the syncengine world — Stripe, AWS, email, SMS, your analytics vendor, a REST API — wrap it in a service. Your workflows get typed `ctx.services.<name>.method(...)` and your tests replace the implementation with a stub.

## Five-line declaration

```ts
// src/services/payments.ts
import { service } from '@syncengine/core';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET!);

export const payments = service('payments', {
  async charge(amount: number, currency: string) {
    return stripe.charges.create({ amount, currency });
  },
  async refund(chargeId: string) {
    return stripe.refunds.create({ charge: chargeId });
  },
});
```

Scaffold command:
```bash
syncengine add service payments
```

Drop it under `src/services/` — any `.ts` file there that exports a `service(...)` call is auto-discovered by the vite plugin and wired into the container at boot.

## Typed ports

The `ServicePort<T>` mapped type extracts the method bag from a service definition:

```ts
import type { ServicePort } from '@syncengine/core';
import { payments } from './payments';

type PaymentsPort = ServicePort<typeof payments>;
// → { charge(amount: number, currency: string): Promise<Stripe.Charge>;
//     refund(chargeId: string): Promise<Stripe.Refund>; }
```

Rarely needed directly — the framework uses it internally to build `ctx.services.payments`.

## Declaring + consuming

Declare which services a workflow / webhook / heartbeat needs:

```ts
import { defineWorkflow } from '@syncengine/server';
import { payments } from '../services/payments';
import { notifications } from '../services/notifications';

export const refundOrder = defineWorkflow('refundOrder', {
  services: [payments, notifications],
}, async (ctx, input: { orderId: string; chargeId: string }) => {
  await ctx.run('refund', () => ctx.services.payments.refund(input.chargeId));
  await ctx.run('notify', () => ctx.services.notifications.send(input.orderId));
});
```

`ctx.services.payments.refund(...)` is fully typed — `ServicesOf<T>` maps the `[payments, notifications]` tuple to `{ payments: PaymentsPort, notifications: NotificationsPort }` at compile time. No casts, no manual interfaces.

## Overriding for tests

The `override()` primitive swaps implementations — same name, same types, different method bodies:

```ts
// src/services/test/payments.ts
import { override } from '@syncengine/core';
import { payments } from '../payments';

export default override(payments, {
  async charge(amount: number, currency: string) {
    return { id: 'ch_test_' + Date.now(), amount, currency } as never;
  },
  async refund(_chargeId: string) {
    return { id: 'rf_test' } as never;
  },
});
```

Wire it in `syncengine.config.ts`:

```ts
export default config({
  services: {
    overrides: process.env.NODE_ENV === 'test'
      ? () => import('./services/test')
      : undefined,
  },
});
```

**Partial overrides** — swap some methods, keep the rest:

```ts
override(payments, {
  async charge() { return { id: 'test' } as never; },
}, { partial: true });   // .refund still uses the production impl
```

For unit tests, use `createBusTestHarness({ services, serviceOverrides })` — see `docs/guides/testing.md`.

## The polymorphic `override()`

One name handles both services and buses:

```ts
override(payments, { charge: ... })              // ServiceOverride
override(payments, partial, { partial: true })   // partial ServiceOverride
override(orderEvents, { mode: BusMode.inMemory() })  // BusOverride
```

First-argument `$tag` dispatches. A narrow `serviceOverride` export exists for callers who want the explicit form.

## Why hex architecture?

Three structural benefits:

1. **Vendor SDKs stop leaking.** Your workflows know about `PaymentsPort`, not `Stripe`. Switching providers changes `src/services/payments.ts` — everything else stays put.
2. **Tests never hit the network.** Service overrides are just function objects. No mocking framework, no network stubs, no flakes.
3. **Compile-time dependency graph.** If you remove a service but a workflow still lists it in `services: [...]`, the framework throws at boot — the service container can't resolve it. No "works in dev, fails at 2am" drift.

## Footguns

- **Methods must be async.** `service('payments', { charge: () => ... })` with a sync function throws at construction.
- **Names starting with `$` or `_` are reserved.** Use snake_case or camelCase.
- **Overrides are swap-in-place.** A full (non-partial) override replaces every method — unspecified ones become undefined. Use `{ partial: true }` when you only want to swap a subset.
- **Services aren't entities.** They're stateless method bags. If you need state between calls, the service wraps an entity or table.

## Pairs with

- **Workflows**, **webhooks**, **heartbeats** — declare `services: [payment, notifications]`, access via `ctx.services.*`.
- **Entities** — don't use services from inside entity handlers (handlers are pure/sync). Trigger a workflow and do the I/O there.
- **Testing harness** — `createBusTestHarness({ services, serviceOverrides })` injects services into subscriber workflows the same way production boot does.

## Links

- Spec: `docs/superpowers/specs/2026-04-19-hexagonal-framework-design.md`
- Core code: `packages/core/src/service.ts`, `overrides.ts`
- Container: `packages/server/src/service-container.ts`
- Demo: `apps/kitchen-sink/src/services/shipping.ts`, `notifications.ts`
