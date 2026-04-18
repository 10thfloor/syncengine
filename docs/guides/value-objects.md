# Value Objects Guide

> `defineValue()` is the sixth primitive — branded domain types with
> invariants, named factories, and pure-function ops. A `UserId` and
> an `OrderId` are non-interchangeable at compile time even if both
> wrap `text()`. A `Money({ amount, currency })` is atomic on the
> wire, auto-re-validates on every op, and rejects invalid payloads
> at every boundary.

## When to reach for value objects

| Primitive | Use for |
|---|---|
| `text()` / `integer()` / etc. | Raw storage columns. No domain semantics. |
| `entity` | Stateful aggregates with handlers. |
| **`defineValue()`** | **Domain types that show up across many columns / payloads — IDs, money, emails, hashes.** |

Reach for a value object the second time a concept crosses a boundary. A single `email: text()` column is fine; three places all validating `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` manually is the sign.

## Five-line declaration — scalar

```ts
// src/values/ids.ts
import { defineValue, text } from '@syncengine/core';

export const UserId  = defineValue('userId',  text());
export const OrderId = defineValue('orderId', text());

export const Email = defineValue('email', text(), {
  invariant: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
  create:    { from: (raw: string) => raw.toLowerCase().trim() },
  ops:       { domain: (e) => e.split('@')[1] },
});
```

`UserId` and `OrderId` are brand-only — no invariant, no factories, just distinct nominal types over `string`.

## Five-line declaration — composite

```ts
// src/values/money.ts
export const Money = defineValue('money', {
  amount: integer(),
  currency: text({ enum: ['USD', 'EUR', 'GBP'] as const }),
}, {
  invariant: (v) => v.amount >= 0,
  create: {
    usd: (cents: number) => ({ amount: cents, currency: 'USD' as const }),
    eur: (cents: number) => ({ amount: cents, currency: 'EUR' as const }),
  },
  ops: {
    add:    (a, b) => ({ amount: a.amount + b.amount, currency: a.currency }),
    scale:  (m, f: number) => ({ amount: Math.round(m.amount * f), currency: m.currency }),
    isZero: (m) => m.amount === 0,
    format: (m) => `${m.currency} ${(m.amount / 100).toFixed(2)}`,
  },
});
```

Composite storage: atomic, JSON-encoded `TEXT` column. The whole object is the unit of merge — no per-component LWW.

## What you get

```ts
Money({ default: Money.create.usd(0) })  // ColumnDef — usable in entity / table
Money()                                   // ColumnDef, no default
Money({ nullable: true })                 // ColumnDef that accepts null

Money.create.usd(1999)                    // branded Money.T — invariant ran
Money.create.eur(500)
Money.unsafe({ amount: -1, currency: 'USD' })  // bypasses invariant — tests only

Money.ops.add(a, b)                       // auto-rebranded — composite ops re-validate
Money.ops.isZero(m)                       // passthrough — boolean return
Money.ops.format(m)                       // passthrough — string return

Money.is(x)                               // x is Money.T (shape + invariant; ignores brand)
Money.equals(a, b)                        // deep structural; recurses into nested values
Money.zod                                 // ZodType — composes into bus schemas
typeof Money.T                            // branded type (phantom at runtime)
```

`ValueType<typeof Money>` is an alias for `typeof Money.T` — convenient in generic contexts.

## Using in entities

```ts
defineEntity('order', {
  state: {
    status:        text({ enum: ['draft', 'paid'] as const }),
    total:         Money({ default: Money.create.usd(0) }),
    customerEmail: Email({ nullable: true }),
    userId:        UserId({ nullable: true }),
  },
  handlers: {
    addItem(state, price: ReturnType<typeof Money.create.usd>, label: string) {
      return emit({
        state: { total: Money.ops.add(state.total, price) },
        effects: [insert(lineItems, { orderId: state.id, price, label })],
      });
    },
    pay(state, email: ReturnType<typeof Email.create.from>) {
      return { status: 'paid' as const, customerEmail: email };
    },
  },
});
```

`buildInitialState` honours `Money({ default: ... })` so handlers start with a valid branded `Money.T` — not `0` or `null`.

## Using in tables

```ts
table('lineItems', {
  id:       id(),
  orderId:  OrderId(),
  price:    Money(),
  label:    text(),
});
```

`insert(lineItems, { price })` validates `price` against Money's invariant at emit time — errors point at the handler that tried to insert a bad row, not at the persist path downstream.

## Using in buses

```ts
bus('paymentEvents', {
  schema: z.object({
    orderId:       OrderId.zod,
    total:         Money.zod,
    customerEmail: Email.zod,
    at:            z.number(),
  }),
});

await paymentEvents.publish(ctx, {
  orderId: OrderId.unsafe('O1'),
  total:   Money.create.usd(1999),
  customerEmail: Email.create.from('alice@example.com'),
  at:      Date.now(),
});
```

The subscriber receives branded types on the other side:

```ts
defineWorkflow('onPaid', { on: on(paymentEvents) }, async (_ctx, event) => {
  Money.format(event.total);        // "USD 19.99"
  Email.ops.domain(event.customerEmail);  // "example.com"
});
```

## Where validation runs

| Boundary | What happens |
|---|---|
| `.create.<fn>(raw)` | Run invariant → stamp brand → return branded. |
| `emit({ state, ... })` handler return | `validateEntityState` walks value columns, `.is()` each, restamp brand. |
| `emit({ effects: [insert(...)] })` | `insert()` record is validated against the table's value columns at emit time. |
| `bus.publish(ctx, payload)` | Bus `schema.safeParse` runs zod — uses value defs' `.zod` with their invariants. |
| NATS state broadcast → client | State arrives as plain JSON; client-side validator re-stamps branded columns before reactive updates fire. |
| Client rebase (optimistic) | Uses the same pure `.is()` as the server — pessimistic/optimistic stay in sync. |

Invariants are the single source of truth. They run everywhere the value crosses a boundary — you can't forget one.

## Nesting

```ts
const Price = defineValue('price', {
  amount:  Money(),      // value column nested in another composite
  taxRate: real(),
}, {
  invariant: (v) => v.taxRate >= 0 && v.taxRate <= 1,
  create:    { withTax: (m: Money.T, rate: number) => ({ amount: m, taxRate: rate }) },
  ops:       { total: (p) => Money.ops.scale(p.amount, 1 + p.taxRate) },
});
```

Inner invariant runs first. `Price.is({...})` walks nested value columns and calls their own `.is()`. `Price.zod` composes `Money.zod` with the tax-rate `refine`. `Price.equals` recurses into Money's equals. Same story for arbitrary depth.

## Testing

Unit tests are trivial — everything is pure:

```ts
import { Money } from '../values/money';

expect(Money.is(Money.create.usd(100))).toBe(true);
expect(() => Money.create.usd(-1)).toThrow(/invariant/);

const sum = Money.ops.add(Money.create.usd(100), Money.create.usd(50));
expect(sum.amount).toBe(150);
```

For kitchen-sink integration (entity + table + bus all using value objects together), drive it through `createBusTestHarness` — see `apps/test/src/__tests__/value-objects.test.ts`.

## `unsafe()` — loud on purpose

```ts
const bad = Money.unsafe({ amount: -1, currency: 'USD' });
// Skips invariant at construction; stamps the brand anyway.
// `Money.is(bad)` returns false because `.is()` always re-runs the
// invariant regardless of brand.
```

Tests use `unsafe` to produce deliberately-invalid fixtures that verify handler rejection paths. Production code should never call it — the name is the linter.

## Cross-value-returning ops — `op(ReturnRef, fn)`

Composite auto-rebrand detects the parent's own shape. Ops that return a **different** value type need the `op()` marker:

```ts
const Price = defineValue('price', { amount: Money(), taxRate: real() }, {
  ops: {
    // Returns Money, not Price — wrap in op(Money, ...) so the
    // framework validates + brands the result.
    total: op(Money, (p) => Money.ops.scale(p.amount, 1 + p.taxRate)),
  },
});
```

Without `op(Money, ...)`, the op return flows through untouched — if `fn` already went through `Money.ops.scale`, it's already branded; but a raw `{amount, currency}` return would stay unbranded. `op()` is the explicit contract: "this op returns a Money".

The marker also lets you write ops whose body produces a raw shape and have the framework re-validate:

```ts
ops: {
  total: op(Money, (p) => ({
    amount: Math.round(p.amount.amount * (1 + p.taxRate)),
    currency: p.amount.currency,
  })),
}
```

## Handler-arg validation — `withArgs([schemas], fn)`

TypeScript erases types at runtime, so the framework can't auto-validate inbound handler args against the declared parameter types. `withArgs` declares them as value-defs or zod schemas at the call site:

```ts
import { withArgs } from '@syncengine/core';

handlers: {
  addItem: withArgs(
    [Money, z.string()] as const,
    (state, price, label) => {
      // price is Money.T — validated + branded before we get here
      // label is string — validated by zod
      return emit({ ... });
    },
  ),
  pay: withArgs(
    [Email] as const,
    (state, email) => ({ status: 'paid' as const, customerEmail: email }),
  ),
}
```

- **Value-def args** — validated via `.is`, stamped via `.unsafe`. Invalid args throw with the value name and the rejected value.
- **Zod args** — validated via `.parse`. Zod's own error shape surfaces.
- **Types flow both ways** — `withArgs([Money, z.string()], fn)` types `fn` as `(state, Money.T, string) => ...`. No duplicated declarations.

`withArgs` replaces the `Money.is(arg) ? arg : Money.unsafe(arg)` ceremony inside handler bodies. Drop it in everywhere handlers take value-typed args.

## Querying composite fields (view escape hatch)

Composite value columns store as JSON-in-TEXT. For per-field filtering without the future indexing primitive, declare a view that extracts the fields:

```ts
export const ordersByCurrency = view('ordersByCurrency', {
  from: [lineItems],
}).pipe(({ lineItems }) =>
  lineItems.map(row => ({
    ...row,
    currency: JSON.parse(row.price).currency as 'USD' | 'EUR' | 'GBP',
  })),
);
```

The view materialises the extracted field; filters / aggregates run on the derived column. Good enough for most cases; `Money({ index: ['amount'] })` generating a SQLite generated column lands as a future slice if demand materialises.

## Evolving value shapes

Value shape changes are breaking for data already serialized in the old shape. Prefer additive-only evolution:

- **Adding an optional field** — old data parses fine (field becomes `undefined`). Safe.
- **Adding a required field** — old data fails the zod schema. Breaking; needs a migration.
- **Renaming a field** — breaking; needs a migration.
- **Tightening the invariant** — old data may fail `.is()` after rehydration. Breaking.

When a breaking change lands, route through the existing migrations system (`packages/core/src/migrations.ts`) and write an upgrader that walks stored state + bus payloads. A first-class `defineValue` migration API is a follow-up once the first real version bump hits.

## Footguns

- **Composite columns aren't queryable per component.** Storage is JSON-in-TEXT, atomic. If you need to filter on `amount` or `currency` separately, either use two scalar columns (Money.Amount + Money.Currency — defeats the point) or wait for the future indexing escape hatch.
- **`ops` that return other value types don't auto-rebrand.** `Price.ops.total(p)` returns `Money.T` — the caller gets a correctly-branded `Money` only because `Money.ops.scale` brands its own output. A raw `{amount, currency}` return would flow through untouched.
- **Scalar brands are nominal, not runtime-detectable on primitives.** `Money.is(x)` on a plain object runs shape + invariant; on a string primitive (for Email etc.) it runs primitive-type + invariant. The brand property isn't physically attached to strings — TypeScript's intersection typing handles the nominal distinction at compile time.
- **Value-shape changes = schema migration.** Adding a field to `Money` or changing its invariant is a breaking change for data already serialized in the old shape. Route through the existing migrations system when the first real version bump lands.
- **Handler-arg validation is manual.** TypeScript doesn't expose handler parameter types at runtime, so the framework can't auto-validate inbound args against the declared types. Handlers either rehydrate explicitly (`Money.is(arg) ? arg : Money.unsafe(arg)`) or accept plain JSON and trust the shape.

## Pairs with

- **Entities** — value columns in state; `validateEntityState` checks on every write + rehydrates on every read.
- **Tables** — value columns in rows; `insert()` validates at emit time.
- **Buses** — value defs' `.zod` composes into bus payload schemas.
- **Services** — service methods can accept + return branded value types; the type-level contract flows through `ctx.services`.

## Links

- Spec: `docs/superpowers/specs/2026-04-20-value-objects-design.md`
- Plan: `docs/superpowers/plans/2026-04-21-value-objects.md`
- Core code: `packages/core/src/value.ts`
- Kitchen-sink demo: `apps/test/src/values/*.ts` + `apps/test/src/__tests__/value-objects.test.ts`
