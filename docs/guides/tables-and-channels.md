# Tables & Channels Guide

> `table()` declares a CRDT-replicated collection, persisted to NATS
> JetStream and synced to every connected client. `channel()` groups
> tables onto their own NATS subject so access control, rate limits,
> and authority checks can gate subsets independently.

## When to reach for a table

| Primitive | Shape | Use for |
|---|---|---|
| **`table`** | **Durable rows, clients subscribe directly** | **Feeds, inboxes, leaderboards, catalogs — anything UI reads as a list.** |
| `entity` | Keyed aggregate with handlers | Atomic state (order status, counter, cart). |
| `topic` | Ephemeral pub/sub | Cursors, presence — lost on reload. |
| `bus` | Durable, server-only | Domain events between workflows. |

Tables are CRDT-merged. Two clients writing to the same row without coordination don't corrupt each other — last-writer-wins by default, per column.

## Five-line declaration

```ts
// src/schema.ts
import { table, id, text, real, integer, channel } from '@syncengine/core';

export const products = table('products', {
  id: id(),
  slug: text(),
  name: text(),
  price: real(),
  stock: integer(),
});

export const catalog = channel('catalog', [products]);
```

Export the table from `src/schema.ts` and the runtime auto-creates the NATS stream on first write.

## Column factories

```ts
id()                                     // required primary key (string)
text()                                   // any string
text({ enum: ['a', 'b', 'c'] as const }) // typed literal union
integer()                                // bigint (wire), number (client)
real()                                   // float64
boolean()                                // true/false
```

Custom merge per column — default is `lww` (last-writer-wins by HLC timestamp):

```ts
price: real({ merge: 'lww' }),           // default
version: integer({ merge: false }),      // first-writer-wins (append-only)
tags: text({ merge: 'set' }),            // union (strings joined by comma)
```

## Channels

Every table needs to belong to exactly one channel. If you don't declare one, the framework creates a per-table channel with the same name:

```ts
// Explicit — the common case:
export const catalog = channel('catalog', [products, categories]);
export const ledger  = channel('ledger',  [transactions, entries]);

// Implicit — one channel per table, same name:
// (nothing to write; it happens automatically)
```

Channels map to NATS subjects `ws.<wsId>.ch.<channelName>.deltas`. That boundary is where you attach:
- NATS subject-level ACLs (authority-based access control)
- Authority seq checks for read-your-writes
- Rate limits per subject

One client subscribes to multiple channels; each channel's deltas stream independently.

## Client-side reading

```tsx
import { useStore } from '@syncengine/client';
import type { DB } from '../schema';
import { products } from '../schema';

function Catalog() {
  const s = useStore<DB>();
  const rows = s.useTable(products);     // reactive — re-renders on any delta
  return rows.map(p => <Product key={p.id} {...p} />);
}
```

For aggregates, filters, joins — use `view()`:

```ts
export const allOrders = view('allOrders', { from: [orderIndex] })
  .pipe(({ orderIndex }) => orderIndex.dedupBy('orderId'));
```

```tsx
const orders = s.useView({ allOrders });
```

Views compile to DBSP pipelines — incremental, push-based, zero over-fetch.

## Writing

Tables don't have `.write(...)` APIs. You write by emitting from entity handlers:

```ts
handlers: {
  place(state, userId: string, now: number) {
    return emit(
      { ...state, status: 'placed' as const },
      { table: orderIndex, record: { orderId: '$key', userId, createdAt: now } },
    );
  },
}
```

That's intentional. Every row has provenance — an entity wrote it, at a specific handler call, with a specific HLC timestamp. Debug tools trace a row back to the handler invocation that emitted it.

## Merge semantics

CRDT merging happens per-column. Two clients can update different columns of the same row concurrently without conflict; two updates to the same column resolve by HLC timestamp.

**Row identity:** the `id()` column. Primary key collision = same row, merged.

**Tombstones:** not supported in v1. Rows are append-only logically; use a `deleted: boolean` column if you need logical deletion.

**Column-level LWW:** each update carries its own HLC; clients compare per-column.

## Footguns

- **Every table needs an `id()`.** Framework throws at construction if missing. Multi-column primary keys aren't supported; synthesise a compound string.
- **Don't prefix columns with `$`.** Reserved for framework-internal fields (projection metadata etc.).
- **Double-assignment warns loudly.** A table in two channels fires a boot-time warning and uses the last channel — this is almost never what you want.
- **Wire type vs client type for `integer()`.** Over the wire it's `bigint` (JSON number precision limits); on the client it's `number`. Handle conversion at boundaries if you serialize externally.

## Pairs with

- **Entities** emit rows via `emit()` effects
- **Views** aggregate tables into derived collections
- **Channels** route tables to NATS subjects for ACL/authority
- **Workflows** can read tables through `ctx.run(() => db.<table>.query(...))`

## Links

- Spec: `docs/superpowers/specs/2026-04-12-storefront-demo-design.md`
- Core code: `packages/core/src/schema.ts`, `channels.ts`, `table.ts`
- Demo: `apps/test/src/schema.ts`
