# Getting Started — The First 15 Minutes

> Build a real-time shop, one primitive at a time. By the end you'll have
> two browser tabs staying in sync without writing a single line of
> websocket or cache-invalidation code.

## 0. Scaffold

```bash
npx syncengine init my-shop
cd my-shop && pnpm install
pnpm dev
```

```
  restate   virtual objects loaded (0 entities)
  nats      streams created (0 channels)
  dbsp      views materialized (0 views)
  vite      http://localhost:5173
```

Three processes, one command. Restate is the durable execution runtime,
NATS is the event transport, Vite is your dev server. You never talk to
any of them directly.

---

## 1. Schema — the domain model

Tables are typed storage. No ORM, no connection string.

```ts
// src/schema.ts
import { table, text, integer, real, id } from '@syncengine/core';

export const products = table('products', {
  id:    id(),
  slug:  text(),
  name:  text(),
  price: real(),
});

export const transactions = table('transactions', {
  id:        id(),
  productId: text(),
  userId:    text(),
  amount:    real(),
  at:        integer(),
});
```

**Why tables matter:** every other primitive references these columns by
type, not by name. Rename a column here, the type checker catches every
caller.

---

## 2. Entity — the atom of consistency

One instance per key. Pure-function handlers. The same code runs
optimistically in the browser and authoritatively on the server.

```ts
// src/entities/inventory.actor.ts
import { entity, integer } from '@syncengine/core';

export const inventory = entity('inventory', {
  state: {
    stock:    integer(),
    reserved: integer(),
  },
  handlers: {
    restock(state, qty: number) {
      return { ...state, stock: state.stock + qty };
    },
  },
});
```

No `ctx`, no `async`, no `Promise`. Handlers are `(state, ...args) => newState`.
That constraint is what lets them run on both sides of the wire.

---

## 3. Emit — declarative effects

When a handler needs to write to a table or publish an event, it
**declares** the effect. The runtime executes it atomically with the
state write.

```ts
// src/entities/inventory.actor.ts
import { entity, integer, emit, insert } from '@syncengine/core';
import { transactions } from '../schema';

export const inventory = entity('inventory', {
  state: { stock: integer(), reserved: integer() },
  handlers: {
    sell(state, qty: number, userId: string, price: number) {
      if (state.stock < qty) throw new Error('out of stock');
      return emit({
        state: { ...state, stock: state.stock - qty },
        effects: [
          insert(transactions, {
            productId: '$key',
            userId,
            amount: price * qty,
            at: Date.now(),
          }),
        ],
      });
    },
  },
});
```

`insert(transactions, ...)` is a typed reference, not a string. The
record shape is checked against `transactions` columns at compile time.

---

## 4. View — derived data, incrementally

A view is a materialized query. Not a cache. The runtime maintains it
with **incremental deltas** — rows are added, not recomputed.

```ts
// src/views/sales.ts
import { view } from '@syncengine/core';
import { transactions } from '../schema';

export const salesByProduct = view(transactions)
  .groupBy(t => t.productId)
  .aggregate(rows => ({ total: rows.sum(r => r.amount), count: rows.count() }));
```

No re-query on write. No cache invalidation. When a row lands in
`transactions`, the view updates in place and pushes the delta to every
connected client.

---

## 5. Client hooks — the UI layer

```tsx
// src/components/BuyButton.tsx
import { useStore } from '@syncengine/client';
import { inventory } from '../entities/inventory.actor';
import { salesByProduct } from '../views/sales';

export function BuyButton({ slug, price }: { slug: string; price: number }) {
  const db = useStore();
  const { state, actions } = db.useEntity(inventory, slug);
  const { salesByProduct: sales } = db.useView({ salesByProduct });

  return (
    <div>
      <p>{state.stock} in stock — {sales[slug]?.count ?? 0} sold</p>
      <button onClick={() => actions.sell(1, 'me', price)}>
        Buy
      </button>
    </div>
  );
}
```

Click the button. `state.stock` drops **instantly** — the handler runs
optimistically in the browser. The server confirms in the background.
The view updates incrementally. Every connected tab sees both changes.

**Open two tabs.** Click Buy in one. Watch the other tab update. That's
the pitch.

---

## 6. Bus — decoupling via events

The entity shouldn't care who reacts to a sale. It just publishes.

```ts
// src/events/orders.bus.ts
import { bus } from '@syncengine/core';
import { z } from 'zod';

export const orderEvents = bus('orderEvents', {
  schema: z.object({
    orderId: z.string(),
    event:   z.enum(['placed', 'paid', 'shipped']),
    total:   z.number(),
  }),
});
```

Then publish inside a handler — same `emit({ state, effects })` shape:

```ts
import { publish } from '@syncengine/core';
import { orderEvents } from '../events/orders.bus';

handlers: {
  sell(state, qty, orderId, total) {
    return emit({
      state: { ...state, stock: state.stock - qty },
      effects: [
        publish(orderEvents, { orderId, event: 'placed', total }),
      ],
    });
  },
}
```

**Both effects execute atomically.** If the runtime fails mid-handler,
the entire handler replays. No partial state, no missing events.

---

## 7. Workflow — durable orchestration

Subscribers are workflows. A workflow is a durable function: `await`
pauses are checkpoints, retries resume from the last step, and
`ctx.sleep(days(3))` actually means three real days.

```ts
// src/workflows/ship-on-pay.workflow.ts
import { defineWorkflow, on, days } from '@syncengine/server';
import { orderEvents } from '../events/orders.bus';
import { shipping, email } from '../services';

export const shipOnPay = defineWorkflow('shipOnPay', {
  on: on(orderEvents).where(e => e.event === 'paid').orderedBy(e => e.orderId),
  services: [shipping, email],
}, async (ctx, event) => {
  const tracking = await ctx.services.shipping.create(event.orderId);
  await ctx.services.email.send(event.orderId, 'shipped', { tracking });
  await ctx.sleep(days(3));
  await ctx.services.email.send(event.orderId, 'review-request');
});
```

Restart the server mid-workflow. The `sleep` survives. The already-run
steps don't re-run. Three days later, the review email fires.

---

## 8. Service — the boundary

Everything that talks to the outside world is a service. Services
declare a port; the runtime injects the adapter.

```ts
// src/services/shipping.ts
import { service } from '@syncengine/core';

export const shipping = service('shipping', {
  create: (orderId: string) => Promise<{ tracking: string }>,
});
```

In tests, you pass a mock. In production, you pass the real adapter.
The workflow code doesn't change.

---

## Zoom out

You just built a hexagonal architecture. **Schema at the center. Services
at the edge.** Every layer is pure, typed, and knows nothing about the
layers outside it.

```
      ╭─ service ─────╮
      │  ╭─ workflow ─╮ │
      │  │  ╭─ bus ──╮ │ │
      │  │  │  view  │ │ │
      │  │  │ entity │ │ │
      │  │  │ schema │ │ │
      │  │  ╰────────╯ │ │
      │  ╰────────────╯ │
      ╰─────────────────╯
```

## Next steps

- [Entities in depth](./entities.md) — transitions, access, emit variants
- [Event bus](./event-bus.md) — delivery semantics, DLQ, ordering
- [Workflows](./workflows.md) — durability, retries, `ctx.sleep`
- [Views](./tables-and-channels.md) — DBSP incremental computation
- [Value objects](./value-objects.md) — typed domain primitives
- [Testing](./testing.md) — vitest harness, no Docker required
- [Deployment](./deployment.md) — single-binary production build
