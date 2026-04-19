# Entity Guide

> `entity()` is the server-side actor primitive. One instance per
> key, single-writer, pure-functional handlers — the atom of
> consistency in a syncengine app.

## When to reach for an entity

| Primitive | Use for |
|---|---|
| `table` + `channel` | Lists clients subscribe to directly (inbox, leaderboard). |
| `topic` | Ephemeral pub/sub (cursors, presence). |
| **`entity`** | **Stateful objects with per-key consistency — orders, counters, user profiles, shopping carts.** |
| `workflow` | Orchestration across entities / services. |

Entities compile to Restate virtual objects: keyed on the instance id, serialised per key, durable across crashes, replayable deterministically.

## Five-line declaration

```ts
// src/entities/order.actor.ts
import { defineEntity, integer, real, text, emit } from '@syncengine/core';
import { orderIndex } from '../schema';

export const order = defineEntity('order', {
  state: {
    status: text({ enum: ['draft', 'placed', 'paid', 'shipped', 'cancelled'] }),
    total: real(),
    createdAt: integer(),
  },
  transitions: {
    draft:     ['placed', 'cancelled'],
    placed:    ['paid', 'cancelled'],
    paid:      ['shipped'],
    shipped:   [],
    cancelled: [],
  },
  handlers: {
    place(state, userId: string, total: number, now: number) {
      return emit({
        state: { ...state, status: 'placed' as const, total, createdAt: now },
        effects: [
          insert(orderIndex, { orderId: '$key', userId, total, createdAt: now }),
        ],
      });
    },
    pay(state)  { return { ...state, status: 'paid' as const }; },
    ship(state) { return { ...state, status: 'shipped' as const }; },
  },
});
```

Drop that file under `src/entities/` with a `.actor.ts` suffix and the vite plugin picks it up automatically. Clients instantly get `useEntity(order, orderId)` with full typing.

## The handler contract

Handlers are **pure functions**: `(state, ...args) => newState`. No `ctx`, no `async`, no `Promise`. That's deliberate.

```ts
handlers: {
  add(state, n: number) {
    return { ...state, count: state.count + n };
  },
}
```

| Rule | Why |
|---|---|
| Handlers must be sync + pure | Runs both client-side (optimistic UI) and server-side (authoritative) from the same source. |
| Omitted fields retain old values | Partial returns merge with prior state — never drop fields you don't know about. |
| No `Date.now()`, no `Math.random()` | Non-determinism breaks Restate replay and desyncs optimistic UI. Pass timestamps as args. |
| `'$key'` resolves to the entity key | When emitting table rows, use `$key` as a placeholder — the entity runtime substitutes the real key before insert. |

## Effects: `emit()`

When a handler needs to do more than mutate state, wrap the return in `emit({ state, effects })`. Every effect builder (`insert()`, `publish()`) returns a tagged value; pass them in the `effects` array:

```ts
return emit({
  state: { ...state, status: 'paid' as const },
  effects: [
    insert(orderIndex, { orderId: '$key', total: state.total }),
    publish(orderEvents, { orderId: state.id, event: 'paid', at: now }),
  ],
});
```

Effects run after state persists, all-or-nothing. A crash between state and effects resumes from the journal and re-runs the effects deterministically.

### Available effects

Tables are CRDT documents. Each column's `merge` strategy is its CRDT op for that path — `lww` for last-write-wins fields, `add` for counters, `set_union` for tag lists. Handlers mutate tables through three verbs, all respecting per-column merge:

| Factory | Purpose | Notes |
|---|---|---|
| `insert(table, record)` | Upsert a full row (create or replace) | `'$key'` / `'$user'` placeholders resolve at publish time |
| `update(table, id, patch)` | Merge a partial patch into an existing row | Patch respects each column's merge; rejects the PK column and `merge:false` columns |
| `remove(table, id)` | Tombstone a row by primary key | Id must match the table's primary-key column kind |
| `publish(bus, payload)` | Fire a typed event on a bus | Schema-validated at call time |
| `trigger(wf, input)` | *(deprecated)* Invoke a named workflow | Migrate to `publish` + `on(bus)` subscribers |

All three row verbs compose in a single `emit()` call — the framework publishes them in the wire order `INSERT → UPDATE → DELETE`, so a handler that replaces-and-deletes or inserts-and-patches sees deterministic ordering. Handlers that need a different order split across two `emit()` calls.

### Updating rows — `update(table, id, patch)`

```ts
editBody(state, noteId: number, body: string) {
  return emit({
    state: { lastEditedId: noteId },
    effects: [update(notes, noteId, { body })],
  });
}
```

The patch is a subset of the table's columns. Each patched column is merged against the existing row using the column's configured `merge` strategy — `update(counter, 7, {clicks: 5})` on a `merge: 'add'` column contributes +5 to the counter at the CRDT layer, not a last-write-wins overwrite. The merge strategy declared on the column *is* the CRDT op.

Patches may not touch the primary-key column (use `remove` + `insert` to change row identity) or columns declared `merge: false`. Both are runtime rejections raised before the effect hits the wire.

If the target row does not exist on the receiving replica, the update is a silent no-op — matching how `insert` silently upserts when its id is already present. Neither verb fails when its assumed state isn't there.

The wire carries only the patch; each replica performs the read-modify-write locally against its own copy of the row. Concurrent updates converge via the same merge machinery that handles concurrent inserts.

### Removing rows — `remove(table, id)`

```ts
toggle(state, rowId: number, noteId: number, userId: string) {
  if (state.rowId !== 0) {
    return emit({
      state: { rowId: 0 },
      effects: [remove(thumbs, state.rowId)],
    });
  }
  return emit({
    state: { rowId },
    effects: [insert(thumbs, { id: rowId, noteId, userId })],
  });
}
```

Writes flow through the same NATS subject as client-initiated `s.tables.X.remove(id)` — same tombstone / LWW behaviour, same data-worker consumer. The id the handler passes must be stable across client-optimistic and server-authoritative runs of the same handler; the usual patterns are:

1. **Caller-supplied id** — the client passes a stable id as a handler argument (like the `rowId` above).
2. **Id in entity state** — the handler stored the id when it inserted and now uses `state.rowId`.
3. **Compound natural key** — if the target table is keyed by `(userId, noteId)` rather than a synthetic `id()`, the handler removes by the natural key.

Entity-emitted writes — both `insert` and `remove` — are **authoritative-only**: the optimistic client run discards effects and only reads state. Emitted rows materialise once the server's NATS publish reaches the replica. State updates remain optimistic.

### Access and effects

The handler's `access:` policy gates the entire call. A caller authorised to invoke a handler is authorised for every effect it emits; there is no per-effect policy surface. Denied callers never reach the handler body, so no effects are produced.

## State machines

`transitions` is optional but powerful. Declare the allowed graph once:

```ts
transitions: {
  draft: ['placed', 'cancelled'],
  placed: ['paid', 'cancelled'],
  paid: ['shipped'],
  shipped: [],
  cancelled: [],
}
```

The framework rejects illegal transitions at the handler boundary, both on the client (UI update blocked) and on the server (invocation returns an error). No `if (state.status !== 'placed') throw` boilerplate.

`text({ enum: [...] })` gives you the literal-union type for state fields so `state.status === 'paid'` narrows correctly.

## Projections — `source`

An entity can **derive its state from a table** instead of holding it directly. Perfect for counters, sums, leaderboards, stock levels.

```ts
export const inventory = defineEntity('inventory', {
  state: { stock: integer() },
  source: {
    from: [transactions],
    where: (row, key) => row.productSlug === key,
    project: (state, row) => ({
      stock: state.stock + (row.kind === 'restock' ? row.qty : -row.qty),
    }),
  },
  handlers: { /* ... */ },
});
```

Every row that matches `where` feeds `project`; the entity reconstructs state deterministically from table deltas. Crashes don't lose history — the projection re-runs from the journal.

## Calling entities from workflows

Use `entityRef(ctx, entity, key)` — get a typed proxy:

```ts
import { defineWorkflow, entityRef } from '@syncengine/server';

export const checkout = defineWorkflow('checkout', async (ctx, input) => {
  const ord = entityRef(ctx, order, input.orderId);
  await ord.place(input.userId, input.total, input.now);
  await ord.pay();
});
```

Calls journal through Restate so workflow replays don't double-fire.

## Reading from the browser

```tsx
import { useStore } from '@syncengine/client';
import type { DB } from '../schema';

function OrderStatus({ orderId }: { orderId: string }) {
  const s = useStore<DB>();
  const { state, actions } = s.useEntity(order, orderId);
  return (
    <div>
      {state?.status ?? 'loading'}
      <button onClick={() => actions.pay()}>Mark paid</button>
    </div>
  );
}
```

`actions.pay()` updates local state optimistically, sends an RPC to Restate, then reconciles when the server responds. `transitions` rejection shows up as an error on the returned promise.

## Testing

Handlers are pure, so unit tests are trivial:

```ts
import { applyHandler } from '@syncengine/core';

const next = applyHandler(order, 'place', { status: 'draft', total: 0, createdAt: 0 }, ['alice', 10, 1000]);
expect(next.status).toBe('placed');
```

For the runtime (including `emit()` effects dispatch + entity projections), see `apps/kitchen-sink/src/__tests__/entities.test.ts`.

## Footguns

- **Don't mutate state in-place.** Always spread. In-place mutation breaks client-side optimistic updates because the reducer sees the same reference.
- **Don't compute timestamps inside handlers.** Pass `now: number` as an argument. Client and server must agree on every value the handler reads.
- **`transitions` is exhaustive.** Every listed state must have a transitions entry (even if `[]`). The framework throws at boot otherwise.

## Links

- Spec: `docs/superpowers/specs/2026-04-13-entity-ref-workflow-design.md`
- Core code: `packages/core/src/entity.ts`
- Runtime: `packages/server/src/entity-runtime.ts`
- Demo: `apps/kitchen-sink/src/entities/order.actor.ts`, `inventory.actor.ts`
