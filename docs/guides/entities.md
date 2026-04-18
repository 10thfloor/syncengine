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
      return emit(
        { ...state, status: 'placed' as const, total, createdAt: now },
        { table: orderIndex, record: { orderId: '$key', userId, total, createdAt: now } },
      );
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

When a handler needs to do more than mutate state, wrap the return in `emit()`. Two forms:

**Legacy form** (inserts into tables):
```ts
return emit(
  { ...state, status: 'placed' as const },
  { table: orderIndex, record: { orderId: '$key', total: state.total } },
);
```

**New form** (any effect type, including publishes):
```ts
return emit({
  state: { ...state, status: 'paid' as const },
  effects: [
    publish(orderEvents, { orderId: state.id, event: 'paid', at: now }),
    // more effects here — framework persists state + dispatches effects atomically
  ],
});
```

Effects run after state persists, all-or-nothing. A crash between state and effects resumes from the journal and re-runs the effects deterministically.

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

For the runtime (including `emit()` effects dispatch + entity projections), see `apps/test/src/__tests__/entities.test.ts`.

## Footguns

- **Don't mutate state in-place.** Always spread. In-place mutation breaks client-side optimistic updates because the reducer sees the same reference.
- **Don't compute timestamps inside handlers.** Pass `now: number` as an argument. Client and server must agree on every value the handler reads.
- **`transitions` is exhaustive.** Every listed state must have a transitions entry (even if `[]`). The framework throws at boot otherwise.

## Links

- Spec: `docs/superpowers/specs/2026-04-13-entity-ref-workflow-design.md`
- Core code: `packages/core/src/entity.ts`
- Runtime: `packages/server/src/entity-runtime.ts`
- Demo: `apps/test/src/entities/order.actor.ts`, `inventory.actor.ts`
