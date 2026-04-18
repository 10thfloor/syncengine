# Testing Guide

> Every primitive has a straightforward unit-test shape. The
> framework's abstractions (pure entity handlers, service overrides,
> the bus harness) were designed so most tests run inline in
> vitest — no Docker, no network, no flakes.

## Two layers

| Layer | What it tests | Harness | Speed |
|---|---|---|---|
| **Unit** | Pure handlers, service overrides, view pipelines, CRDT merges | `applyHandler`, `override`, direct calls | 1–5 ms |
| **Integration** | Entity runtime + bus + workflows together | `createBusTestHarness` | 10–50 ms |

Use the cheapest layer that gives you confidence. Most code should live in the unit layer.

## Entity handlers — pure

Handlers are `(state, ...args) => newState`. Call them directly:

```ts
import { applyHandler } from '@syncengine/core';
import { order } from '../entities/order.actor';

it('place transitions draft → placed', () => {
  const next = applyHandler(
    order, 'place',
    { status: 'draft', total: 0, productSlug: '', userId: '', price: 0, customerEmail: '', createdAt: 0 },
    ['alice', 'widget', 10, 1000],
  );
  expect(next.status).toBe('placed');
  expect(next.total).toBe(0);  // unset in this handler — retained
});
```

`applyHandler` validates transitions against the declared graph, merges partial returns against the input state, and strips emit-symbol metadata — matching what the runtime does at rebase time.

## Emit effects — extract and inspect

`publish()` effects ride on the returned state under a Symbol key. Pull them out:

```ts
import { extractPublishes } from '@syncengine/core';

const result = order.$handlers.pay({ ...baseState }, { orderId: 'O1', at: 0 });
const publishes = extractPublishes(result) ?? [];
expect(publishes).toHaveLength(1);
expect(publishes[0]).toMatchObject({
  bus: { $name: 'orderEvents' },
  payload: { orderId: 'O1', event: 'paid' },
});
```

Same story for `extractEmits` (table inserts) and `extractTriggers` (deprecated; use bus).

## Services — swap with `override()`

Production service:
```ts
export const payments = service('payments', {
  async charge(amount: number) { return stripe.charges.create({ amount }); },
});
```

Test swap:
```ts
import { override } from '@syncengine/core';
const testPayments = override(payments, {
  async charge(amount: number) { return { id: `ch_test_${amount}` } as never; },
});
```

For partial overrides (swap one method, keep the rest):
```ts
override(payments, {
  async charge() { return { id: 'test' } as never; },
}, { partial: true });
```

Pass the override into the bus harness or your own workflow-test setup via `serviceOverrides: [testPayments]`.

## Bus — `createBusTestHarness`

The harness stands in for NATS + Restate. Two modes:

### Capture only

Quick "did my entity publish?" check:

```ts
import { createBusTestHarness } from '@syncengine/server/test';
import { orderEvents } from '../events/orders.bus';

const harness = createBusTestHarness();
const result = order.$handlers.pay({ ...base }, { orderId: 'O1', at: 0 });
const published = harness.capturePublishEffects(result);
expect(published).toHaveLength(1);
harness.dispose();
```

Or imperative `bus.publish(ctx, ...)` against a mock ctx:

```ts
await orderEvents.publish(harness.ctx(), { orderId: 'X', event: 'paid', at: 0, total: 10 });
expect(harness.publishedOn(orderEvents)).toHaveLength(1);
```

### Full dispatch

Pass `workflows` + `services` and the harness fires subscribers inline with typed `ctx.services` injection:

```ts
const harness = createBusTestHarness({
  workflows: [shipOnPay, alertOnShippingFailure] as never,
  services: [shipping, notifications],
});

await orderEvents.publish(harness.ctx(), { orderId: 'fail-X', event: 'paid', at: 0, total: 10 });

// TerminalError thrown by shipOnPay → routed to orderEvents.dlq →
// alertOnShippingFailure fires in the same pass.
expect(harness.dispatchedFor(shipOnPay)[0]!.outcome).toBe('terminal-error');
expect(harness.dispatchedFor(alertOnShippingFailure)).toHaveLength(1);
```

The harness mirrors production's `.where` predicate, `TerminalError` → DLQ classifier, and `ctx.services` resolution. It deliberately skips JetStream durability, retry schedules, and Restate journaling — those are infra concerns; unit tests should assert on domain outcomes.

See `docs/guides/event-bus.md` for the full harness API.

## Workflows

For workflows without `on:`, call the handler with a mock ctx:

```ts
const mockCtx = {
  services: {
    payments: { async charge(amount: number) { return { id: 'ch_test' }; } },
  },
  run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  sleep: async () => {},
  date: { now: () => 1000 },
  key: 'ws1/inv1',
} as never;

await checkout.$handler(mockCtx, { userId: 'a', orderId: 'O1', productSlug: 'w', price: 10, timestamp: 0 });
```

For subscriber workflows, use the bus harness — it builds the ctx for you.

## CRDT / table merges

The merge logic in core is pure — test directly:

```ts
import { mergeRows } from '@syncengine/core';
const merged = mergeRows(existing, incoming, { columns: products.$columns });
expect(merged.price).toBe(incoming.price);  // LWW by HLC
```

`apps/kitchen-sink/src/__tests__/views.test.ts` has richer examples including DBSP view pipelines.

## Common patterns

**Test transitions exhaustively.** Every state × handler pair should have either "transitions" or "throws" coverage. Use `applyHandler` + `toThrow`.

**Don't mock the bus.** Use `createBusTestHarness()`. It's as fast as a mock and matches production semantics, including DLQ routing.

**Don't mock services.** Use `override(svc, ...)` — same types, guaranteed-matching shape.

**Assert on domain, not framework.** `expect(harness.dispatchedFor(shipOnPay)).toHaveLength(1)` is better than `expect(mockNats.publish).toHaveBeenCalledWith(...)`. The first survives internal refactors.

## Footguns

- **Harness disposal matters.** `createBusTestHarness()` installs a module-level publisher; always call `harness.dispose()` in `afterEach` or the next harness install will silently overwrite the previous one and tests will cross-pollinate.
- **`beforeEach`, not module-level.** Don't `let harness = createBusTestHarness()` at module scope — two describe blocks will fight over the publisher seam. Install per-test.
- **Non-determinism in unit tests** still bites if you're asserting on `state.createdAt`. Pass timestamps explicitly.
- **`as never` on workflow arrays** is a deliberate widening — `WorkflowDef<string, T>` is invariant in T, so a tuple of typed defs doesn't unify. The harness uses `any` internally; the cast is safe.

## Links

- Bus harness code: `packages/server/src/test/bus-harness.ts`
- Entity handler runtime: `packages/core/src/entity.ts`
- Service override: `packages/core/src/overrides.ts`
- Example specs: `apps/kitchen-sink/src/__tests__/`, `packages/server/src/__tests__/`
