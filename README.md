<div align="center">

# syncengine

**Real-time, durable, end-to-end-typed apps in TypeScript.**

You write pure domain logic. The framework handles sync, state, orchestration, and durability.

[![ci](https://github.com/10thfloor/syncengine/actions/workflows/ci.yml/badge.svg)](https://github.com/10thfloor/syncengine/actions/workflows/ci.yml)
[![jsr](https://jsr.io/badges/@syncengine)](https://jsr.io/@syncengine)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[Documentation](./docs/guides/README.md) · [Examples](./apps) · [License](./LICENSE)

</div>

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/10thfloor/syncengine/main/install/install.sh | bash
syncengine init my-app
cd my-app
pnpm install
pnpm dev
```

## A hex-shaped framework

The primitives are arranged as concentric rings — pure data at the
center, stateful domain logic in between, orchestration and vendor
SDKs at the edge. Inner rings don't know about outer ones, and the
type system follows the shape, so most layering mistakes surface as
TypeScript errors rather than runtime bugs. The file-suffix
convention gives the rings a visible home in your repo.

It's a nudge, not a cage. The goal is to keep each handler small
enough to reason about — not to win an argument about architecture.

<div align="center">

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420" width="380" height="380" role="img" aria-label="Concentric architecture rings from schema at the center to service at the edge">
  <circle cx="210" cy="210" r="200" fill="#ef4444" />
  <circle cx="210" cy="210" r="168" fill="#f97316" />
  <circle cx="210" cy="210" r="136" fill="#eab308" />
  <circle cx="210" cy="210" r="104" fill="#22c55e" />
  <circle cx="210" cy="210" r="72"  fill="#6366f1" />
  <circle cx="210" cy="210" r="40"  fill="#f472b6" />
  <g font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif" font-size="14" font-weight="600" fill="#ffffff" text-anchor="middle">
    <text x="210" y="26">service</text>
    <text x="210" y="58">workflow</text>
    <text x="210" y="90">bus</text>
    <text x="210" y="122">view</text>
    <text x="210" y="154">entity</text>
    <text x="210" y="215">schema</text>
  </g>
</svg>

</div>

## Building blocks

Six primitives in a few lines of code each. Together they're a
hexagonal architecture — schema at the center, services at the edge,
walls enforced by the type system.

### Schema

<sub>`src/schema.ts` · runs on client + server</sub>

Typed tables. No ORM, no migrations, no connection string. Every other
primitive references these columns by value — rename one here, the
compiler catches every caller.

```ts
// src/schema.ts
import { table, id, text, real, integer } from '@syncengine/core';

export const transactions = table('transactions', {
  id:          id(),
  productSlug: text(),
  userId:      text(),
  amount:      real(),
  timestamp:   integer(),
});
```

<sub>→ [Guide: Tables & channels](./docs/guides/tables-and-channels.md)</sub>

### Views

<sub>`src/views/*.ts` · runs on client + server</sub>

Materialized queries that update incrementally. When a row lands in
`transactions`, the view recomputes its delta — not the whole result —
and pushes the change to every connected client.

```ts
// src/views/sales.ts
import { view, sum, count } from '@syncengine/core';
import { transactions } from '../schema';

export const salesByProduct = view(transactions)
  .aggregate([transactions.productSlug], {
    total: sum(transactions.amount),
    count: count(),
  });
```

No cache to invalidate. Writes produce deltas, not re-scans.

<sub>→ [Guide: Tables & channels](./docs/guides/tables-and-channels.md)</sub>

### Entities

<sub>`src/entities/*.actor.ts` · runs on client (optimistic) + server (authoritative)</sub>

One instance per key. Pure-function handlers — `(state, ...args) => newState`.
The runtime compiles them to durable virtual objects, single-writer per
key, replayable after crashes.

```ts
// src/entities/inventory.actor.ts
import { entity, integer, emit } from '@syncengine/core';
import { transactions } from '../schema';

export const inventory = entity('inventory', {
  state: { stock: integer() },
  handlers: {
    restock(state, amount: number) {
      return { ...state, stock: state.stock + amount };
    },
    sell(state, userId: string, price: number, now: number) {
      if (state.stock <= 0) throw new Error('out of stock');
      return emit(
        { ...state, stock: state.stock - 1 },
        { table: transactions, record: {
            productSlug: '$key', userId, amount: price, timestamp: now,
        }},
      );
    },
  },
});
```

`emit(state, effect)` is atomic. The state transition and the row write
commit together, or neither does.

<sub>→ [Guide: Entities](./docs/guides/entities.md)</sub>

### Client

<sub>`src/components/*.tsx` · runs in the browser</sub>

The same handler runs in the browser (optimistic) and on the server
(authoritative). One implementation, two call sites, zero divergence.

```tsx
import { useStore } from '@syncengine/client';
import { inventory } from '../entities/inventory.actor';
import { salesByProduct } from '../views/sales';

export function BuyButton({ slug, price }: { slug: string; price: number }) {
  const s = useStore();
  const { state, actions } = s.useEntity(inventory, slug);
  const { views }          = s.useView({ salesByProduct });

  return (
    <button onClick={() => actions.sell('me', price, Date.now())}>
      Buy — {state?.stock} left · {views.salesByProduct[slug]?.count ?? 0} sold
    </button>
  );
}
```

Click. `state.stock` drops instantly. Every other tab sees it a moment
later, once the server confirms. No websocket code, no cache
invalidation, no mutation hooks.

<sub>→ Guide: Client hooks *(coming soon)*</sub>

### Bus

<sub>`src/events/*.bus.ts` · declaration shared · publish from client or server</sub>

Typed events, atomic with state. The entity doesn't care who subscribes
— it just publishes.

```ts
// src/events/orders.bus.ts
import { bus, Retention, Delivery, days } from '@syncengine/core';
import { z } from 'zod';

export const orderEvents = bus('orderEvents', {
  schema: z.object({
    orderId: z.string(),
    event:   z.enum(['placed', 'paid', 'shipped']),
    total:   z.number(),
  }),
  retention: Retention.durableFor(days(30)),
  delivery:  Delivery.fanout(),
});
```

Publish inside the same `emit` that transitions state:

```ts
import { emit, publish } from '@syncengine/core';
import { orderEvents } from '../events/orders.bus';

pay(state, req: { orderId: string; at: number }) {
  return emit({
    state: { ...state, status: 'paid' as const },
    effects: [
      publish(orderEvents, {
        orderId: req.orderId,
        event:   'paid',
        total:   state.total,
      }),
    ],
  });
}
```

The write and the publish commit atomically. If the handler replays,
both fire exactly once. If it fails, neither fires.

<sub>→ [Guide: Event bus](./docs/guides/event-bus.md)</sub>

### Workflows

<sub>`src/workflows/*.workflow.ts` · server-only (stubbed on client at build time)</sub>

Subscribers are workflows — durable functions where `await` means
*checkpoint*. Retries resume from the last step. `ctx.sleep(days(3))`
means three real days, across restarts and deploys.

```ts
// src/workflows/ship-on-pay.workflow.ts
import { defineWorkflow, on } from '@syncengine/server';
import { Retry, seconds, days } from '@syncengine/core';
import { orderEvents } from '../events/orders.bus';
import { shipping } from '../services/shipping';
import { notifications } from '../services/notifications';

export const shipOnPay = defineWorkflow('shipOnPay', {
  on:       on(orderEvents).where(e => e.event === 'paid'),
  services: [shipping, notifications],
  retry:    Retry.exponential({ attempts: 2, initial: seconds(1), max: seconds(10) }),
}, async (ctx, event) => {
  // 1. Ship it.
  const { trackingId } = await ctx.services.shipping.create(event.orderId);

  // 2. Notify the customer.
  await ctx.services.notifications.sendSlack({
    channel: '#orders',
    text:    `order ${event.orderId} shipped (${trackingId})`,
  });

  // 3. Wait three real days — across restarts, deploys, crashes.
  await ctx.sleep(days(3));

  // 4. Follow up once the package has had time to arrive.
  await ctx.services.notifications.sendSlack({
    channel: '#orders',
    text:    `how was your order ${event.orderId}? we'd love a review.`,
  });

  // 5. Announce completion on the bus for anyone else who cares.
  await orderEvents.publish(ctx, {
    orderId: event.orderId,
    event:   'shipped',
    total:   event.total,
  });
});
```

`ctx.services.shipping` and `ctx.services.notifications` are typed,
inferred from the `services: [...]` tuple — no casts. Every `await` is
a checkpoint: kill the server mid-`ctx.sleep` and the workflow resumes
on schedule when it comes back up. Failures with a terminal status
route to `orderEvents.dlq` automatically.

<sub>→ [Guide: Workflows](./docs/guides/workflows.md)</sub>

### Services

<sub>`src/services/*.ts` · server-only</sub>

The outermost ring. Everything that talks to a vendor SDK, a payment
gateway, an email provider — declared as a port, implemented as an
adapter. Workflows depend on the port; the runtime injects the adapter.

```ts
// src/services/shipping.ts
import { service } from '@syncengine/core';

export const shipping = service('shipping', {
  async create(orderId: string): Promise<{ trackingId: string }> {
    return { trackingId: `trk_${orderId}` };
  },
});
```

Mock in tests via `override(shipping, { ... })`. The workflow code never
changes.

<sub>→ [Guide: Services](./docs/guides/services.md)</sub>

---

## Beyond the core

Primitives that live alongside the hex — inbound HTTP, recurring jobs,
ephemeral channels, and the tenancy scope that wraps everything.

### Webhooks

<sub>`src/webhooks/*.webhook.ts` · server-only</sub>

Inbound HTTP from third parties — Stripe, GitHub, Slack. Each webhook
compiles to a durable Restate workflow keyed on an idempotency value, so
retries and duplicate deliveries collapse to one execution. Signature
verification happens before body parsing.

```ts
// src/webhooks/notify.webhook.ts
import { webhook, entityRef } from '@syncengine/server';
import { inbox } from '../entities/inbox.actor';

export const notify = webhook('notify', {
  path: '/notify',
  verify: { scheme: 'hmac-sha256', secret: () => process.env.NOTIFY_SECRET!, header: 'x-signature' },
  idempotencyKey: (req) => req.headers.get('x-event-id') ?? crypto.randomUUID(),
  run: async (ctx, payload: { text: string; from?: string }) => {
    await entityRef(ctx, inbox, 'main').receive(payload.text, payload.from ?? 'webhook', Date.now());
  },
});
```

<sub>→ [Guide: Webhooks](./docs/guides/webhooks.md)</sub>

### Heartbeats

<sub>`src/heartbeats/*.heartbeat.ts` · server-only</sub>

Durable recurring work. Leader-elected across replicas, crash-safe,
resumable across deploys — `setInterval` would drop ticks every time
the process restarts.

```ts
// src/heartbeats/pulse.heartbeat.ts
import { heartbeat } from '@syncengine/server';

export const pulse = heartbeat('pulse', {
  every: '5m',           // or a cron expression
  scope: 'workspace',    // or 'global' for cluster-wide
  run: async (ctx) => {
    // runs server-side on Restate — full workflow ctx available
  },
});
```

<sub>→ [Guide: Heartbeats](./docs/guides/heartbeats.md)</sub>

### Topics

<sub>`src/topics/*.ts` · runs on client + server</sub>

Ephemeral pub/sub — cursors, presence, typing indicators. Same typed
schema as tables, but with no persistence, no DBSP, no Restate: just a
direct NATS publish on one side and a subscription on the other.

```ts
// src/topics/cursors.ts
import { topic, real, text } from '@syncengine/client';

export const cursorTopic = topic('cursors', {
  x: real(),
  y: real(),
  userId: text(),
});
```

Use from a component with `useTopic(cursorTopic, 'global')` — publish
at 20fps, every other tab gets the stream without writing to storage.

<sub>→ [Guide: Topics](./docs/guides/topics.md)</sub>

### Workspaces

<sub>`syncengine.config.ts` · cross-cutting scope</sub>

Every primitive above is automatically isolated by workspace. You decide
what a workspace means — a document, a team, a tenant, a user id — and
the framework handles the routing: different NATS subjects, different
Restate keys, zero cross-talk.

```ts
// syncengine.config.ts
import { config } from '@syncengine/core';

export default config({
  workspaces: {
    resolve: ({ request }) => {
      const url = new URL(request.url);
      return url.searchParams.get('ws') ?? 'default';
    },
  },
});
```

A write in workspace A literally cannot be seen from workspace B — not
a filter at query time, but a routing decision at the wire. Multi-tenant
is the default, not an add-on.

<sub>→ [Guide: Workspaces](./docs/guides/workspaces.md)</sub>

---

## Project layout

File suffixes carry meaning. They tell the framework what each file is,
so you never register anything — drop it in and it's wired — and they
let the bundler strip server-only code from the client build without you
thinking about it.

```
src/
├─ schema.ts               shape of the world
├─ entities/*.actor.ts     stateful domain objects
├─ views/*.ts              materialized queries
├─ events/*.bus.ts         typed event streams
├─ workflows/*.workflow.ts durable subscribers + orchestration
├─ services/*.ts           driven ports (hex adapters)
├─ webhooks/*.webhook.ts   inbound HTTP with signature verification
├─ heartbeats/*.heartbeat.ts durable scheduled work
├─ topics/*.ts             ephemeral pub/sub (cursors, presence)
├─ values/*.ts             branded domain types
└─ components/*.tsx        React UI
```

| Suffix            | Runs on                                   |
|-------------------|-------------------------------------------|
| `.actor.ts`       | client (optimistic) + server (authoritative) |
| `.bus.ts`         | declaration shared; publish from either side  |
| `.workflow.ts`    | **server only** — stubbed on the client       |
| `.webhook.ts`     | **server only** — stubbed on the client       |
| `.heartbeat.ts`   | **server only** — stubbed on the client       |
| `.metrics.ts`     | **server only** — observability hooks         |
| (no suffix)       | isomorphic — schema, views, services, values  |

Server-only suffixes resolve to an empty shell on the client and full
code on the server — no separate `server/` and `client/` directories to
maintain.

## Features

- **Pure-function handlers** that run on both sides of the wire.
- **Real-time by default** — entities and views stream without opt-in.
- **Durable execution** — workflows survive crashes, retries, and deploys.
- **Incremental views** — writes produce deltas, not re-queries.
- **Typed events** — every publish is schema-validated; every subscriber gets a typed payload.
- **Atomic effects** — state writes and publishes commit together, or not at all.
- **Hex walls by types** — architectural violations fail at compile time.
- **Multi-tenant by default** — every primitive is workspace-scoped at the wire, not filtered at query time.
- **Auth built in** — declarative `access:` policies, pluggable identity, `$system` identity for workflow-initiated calls.
- **OpenTelemetry everywhere** — every handler, effect, subscriber, and service call is traced. Drop in your collector.
- **In-memory test harness** — `vitest` runs the whole app. No Docker required.

## What is syncengine

A full-stack TypeScript framework for building applications where
real-time sync, durable execution, and multi-tenant isolation are the
defaults — not libraries you bolt on later. You declare your domain
with a handful of primitives; the framework wires up the transport,
storage, orchestration, and type safety behind them.

The runtime is a carefully chosen stack of proven infrastructure, each
handled behind a typed adapter so your code never imports them
directly.

| Concern           | Implementation                               |
|-------------------|----------------------------------------------|
| Durable execution | [Restate](https://restate.dev) virtual objects |
| Event transport   | [NATS JetStream](https://nats.io)            |
| Incremental views | [DBSP](https://github.com/feldera/feldera) (WASM) |
| Edge HTTP         | [Bun](https://bun.sh) compiled binary        |
| Dev server        | [Vite](https://vitejs.dev) plugin            |
| Validation        | [Zod](https://zod.dev)                       |

## Documentation

- **[Entities](./docs/guides/entities.md)** — state machines, transitions, access
- **[Tables & views](./docs/guides/tables-and-channels.md)** — schema and DBSP
- **[Event bus](./docs/guides/event-bus.md)** — delivery, ordering, DLQ
- **[Workflows](./docs/guides/workflows.md)** — durability, retries, sleep
- **[Services](./docs/guides/services.md)** — ports and adapters
- **[Webhooks](./docs/guides/webhooks.md)** — inbound HTTP, signature verification, idempotency
- **[Heartbeats](./docs/guides/heartbeats.md)** — durable recurring work (interval or cron)
- **[Topics](./docs/guides/topics.md)** — ephemeral pub/sub (cursors, presence)
- **[Value objects](./docs/guides/value-objects.md)** — branded domain types
- **[Workspaces](./docs/guides/workspaces.md)** — multi-tenant scope resolution + isolation
- **[Auth](./docs/guides/auth.md)** — identity, access policies, pluggable providers
- **[Observability](./docs/guides/observability.md)** — OpenTelemetry traces, metrics, logs
- **[Testing](./docs/guides/testing.md)** — harness + overrides
- **[Deployment](./docs/guides/deployment.md)** — single-binary production build

## Status

Pre-1.0. Core primitives are stable; the kitchen-sink demo in
[`apps/test`](./apps/test) exercises every feature end-to-end against
real Restate + NATS. APIs may still move before 1.0 — breaking changes
will be called out in the changelog.

## License

[MIT](./LICENSE) — © 2026 Mackenzie Kieran
