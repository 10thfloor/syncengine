# kitchen-sink

The reference app for syncengine. One demo that exercises every
primitive end-to-end — schema, value objects, entities, views, bus,
workflows, services, webhooks, topics, heartbeats, workspaces,
observability — against real NATS + Restate.

Used by the docs (most "Demo:" links in `docs/guides/` point here) and
by contributors as the go-to place to grep when a guide snippet isn't
enough.

## Running locally

From the repo root:

```bash
pnpm install
pnpm dev          # runs `syncengine dev` in apps/kitchen-sink
```

Or from this directory directly:

```bash
pnpm dev
```

Open two tabs at `http://localhost:5173/?user=alice` and
`http://localhost:5173/?user=bob` to see real-time sync across
sessions. Add `&workspace=team-a` for an isolated tenant scope.

## What's in here

### Storefront / inventory demo (the main tab set)

A small e-commerce flow exercising the core primitives together.

| Tab | Exercises |
|---|---|
| **Catalog** | `useEntity(inventory, slug)` with optimistic `restock()` / `sell()`. Per-product stock + totalSold, reactive across tabs. |
| **Checkout** | Two-actor saga — `inventory.reserve()` → `inventory.sell()` → RPC to `order.place()`. Reservation TTL, atomic `emit({ state, effects })`. |
| **Orders** | `useView({ allOrders })` for the list, per-row `useEntity(order, id)` for live status. State-machine transitions (draft → placed → packed → shipped → delivered / cancelled). |
| **Activity** | Three DBSP views on `transactions`: `salesByProduct`, `totalSales`, `recentActivity`. Incremental updates, zero re-query. |

### Under the surface

- **`src/schema.ts`** — four tables (`products`, `transactions`,
  `orderIndex`) + four views (aggregates, topN, joins)
- **`src/entities/inventory.actor.ts`** — stock + reservations with
  state-machine guards, source projection from `transactions`
- **`src/entities/order.actor.ts`** — full lifecycle state machine,
  `emit({ effects: [publish(orderEvents, …)] })` on `pay()`
- **`src/values/money.ts` + `ids.ts`** — branded `Money` type with
  invariants, `ops.add`, `ops.format`; plugs into `products.price`
- **`src/events/orders.bus.ts`** — typed bus with retention +
  fanout + DLQ, `OrderEventSchema` validated at publish
- **`src/workflows/ship-on-pay.workflow.ts`** — bus subscriber with
  `.where(e => e.event === 'paid')`, per-subscriber retry,
  terminal-error routing to `orderEvents.dlq`
- **`src/workflows/alert-on-shipping-failure.workflow.ts`** — DLQ
  subscriber that logs via `notifications.sendSlack()`
- **`src/workflows/advance-order-on-shipped.workflow.ts`** —
  bus-driven state-machine advance, no direct entity coupling
- **`src/workflows/checkout.workflow.ts`** — durable saga with
  `entityRef`, compensating `cancel-order` workflow on failure
- **`src/services/shipping.ts`, `notifications.ts`** — hex ports;
  test overrides swap these out for mocks
- **`src/topics/cursors.ts`** — ephemeral pub/sub for live-cursor
  overlay (not persisted)
- **`src/orders.metrics.ts`** — OpenTelemetry metric declarations
  discovered via `.metrics.ts` suffix

### Tests

`src/__tests__/` — ~70 unit + integration tests exercising every
primitive through `createBusTestHarness`, `applyHandler`,
`override()`, and direct DBSP view evaluation. No Docker, no
network, no flakes.

```bash
pnpm -F kitchen-sink test
```

## Orders that demo specific paths

A few magic orderIds trigger deliberate failure paths:

- `fail-*` — `shipping.create()` throws a `TerminalError`, routing
  the event to `orderEvents.dlq`, which wakes
  `alertOnShippingFailure`
- Otherwise the happy path: `shipOnPay` → `shipping.create()` →
  `orderEvents.publish(ctx, { event: 'shipped' })` →
  `advanceOrderOnShipped` flips the entity state machine

## Configuration

`syncengine.config.ts` uses the dev-only `unverified()` auth adapter
— any `?user=<id>` query string is trusted as the bearer token, so
presence works without a login flow. Swap to `jwt({ jwksUri, ... })`
before shipping.

## Why "kitchen-sink"

Because every feature lands here first, exercised end-to-end, before
any guide claims the feature exists. If a guide shows a primitive
doing something, `grep -r` here finds the canonical usage.
