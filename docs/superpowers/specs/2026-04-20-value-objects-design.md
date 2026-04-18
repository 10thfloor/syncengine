# Value Objects Primitive for syncengine

**Date:** 2026-04-20
**Status:** Draft

## Context

syncengine's schema DSL provides five primitive column types: `id()`, `integer()`, `real()`, `text()`, `boolean()`. These are storage-level primitives with no domain semantics. A `text()` column that holds an email address is indistinguishable from one that holds a username — the type system can't prevent passing one where the other is expected, and validation is ad-hoc.

The framework already has a precedent for branded domain types: `Duration` and `Bytes` in `packages/core/src/` use `unique symbol` branding with named factory functions (`days(7)`, `bytes.mib(50)`) to prevent dimensional confusion at compile time. But these are framework-internal config types, not user-facing schema primitives.

**Pain points:**

1. **No type distinction between semantically different values** — `userId` and `orderId` are both `text()`, freely interchangeable at the type level
2. **No composite domain concepts** — Money (amount + currency) is modeled as two independent columns with no atomic grouping
3. **Validation is ad-hoc** — invariants like "amount must be non-negative" are checked manually in handlers, not enforced by the framework
4. **No domain operations** — transforming values (Money.add, Email.domain) has no conventional home

**Approach:** `defineValue` — a new primitive that extends the column system with branded, validated, optionally composite domain types. Value objects are callable as column factories (same API surface as `integer()`, `text()`) and carry named constructors, invariants, domain operations, and equality — all framework-enforced at handler boundaries.

---

## 1. `defineValue` API

### 1.1 Composite Value Objects

A composite value object groups multiple columns into an atomic unit:

```ts
import { defineValue, integer, text, real } from 'syncengine';

const Money = defineValue('money', {
  amount: integer(),
  currency: text({ enum: ['USD', 'EUR', 'GBP'] as const }),
}, {
  // Invariant — runs on every construction and handler boundary
  invariant: (v) => v.amount >= 0,

  // Named factories — the only way to construct a branded value
  create: {
    usd: (cents: number) => ({ amount: cents, currency: 'USD' as const }),
    eur: (cents: number) => ({ amount: cents, currency: 'EUR' as const }),
    gbp: (cents: number) => ({ amount: cents, currency: 'GBP' as const }),
  },

  // Domain operations — pure functions on the value
  ops: {
    add: (a, b) => {
      if (a.currency !== b.currency) {
        throw new EntityError('CURRENCY_MISMATCH', 'Cannot add different currencies');
      }
      return { amount: a.amount + b.amount, currency: a.currency };
    },
    scale: (m, factor: number) => ({
      ...m,
      amount: Math.round(m.amount * factor),
    }),
    isZero: (m) => m.amount === 0,
    format: (m) => `${m.currency} ${(m.amount / 100).toFixed(2)}`,
  },
});
```

### 1.2 Scalar Value Objects

A scalar value object wraps a single column type with branding and optional validation:

```ts
const Email = defineValue('email', text(), {
  invariant: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),

  create: {
    from: (raw: string) => raw.toLowerCase().trim(),
  },

  ops: {
    domain: (e) => e.split('@')[1],
  },
});

// Minimal — branding only, no validation or ops
const UserId = defineValue('userId', text());
const OrderId = defineValue('orderId', text());
```

### 1.3 API signature

The second argument determines the form:

| Form | Second argument | Storage |
|------|----------------|---------|
| Composite | `Record<string, ColumnDef>` (object of columns) | JSON-encoded `TEXT` column, atomic LWW |
| Scalar | Single `ColumnDef` | Native column type (INTEGER, TEXT, etc.) |

---

## 2. Return Shape of `defineValue`

`defineValue` returns a callable object that serves multiple roles:

```ts
// Column factory — usable anywhere integer() or text() is accepted
Money({ default: Money.usd(0) })        // → ColumnDef<Money.T>
Money({ nullable: true })               // → ColumnDef<Money.T | null>
Money()                                 // → ColumnDef<Money.T> (no default)

// Named factories — construct branded, validated values
Money.usd(1999)                         // → Money.T (branded)
Money.eur(500)                          // → Money.T (branded)

// Domain operations
Money.add(a, b)                         // → Money.T (re-validated)
Money.scale(m, 1.1)                     // → Money.T (re-validated)
Money.isZero(m)                         // → boolean (passthrough)
Money.format(m)                         // → string (passthrough)

// Type export
type M = Money.T;                       // branded type for signatures

// Equality
Money.equals(a, b)                      // → boolean (deep structural)

// Type guard
Money.is(x)                             // → x is Money.T (runtime check)

// Zod schema (for bus validation)
Money.zod                               // → z.ZodType<Money.T>

// Escape hatch (testing only)
Money.unsafe({ amount: -5, currency: 'USD' })  // → Money.T, no validation
```

### 2.1 Ops return type handling

The framework distinguishes ops that return the same value shape from ops that return something else:

- **Self-returning ops** (`add`, `scale`): the return value is automatically re-validated against the invariant and re-branded. If the invariant fails, the op throws.
- **Other-returning ops** (`isZero`, `format`): the return value passes through as-is. No validation, no branding.

The framework infers this from the op's return type at the type level. At runtime, it checks whether the returned value matches the value object's shape and applies validation accordingly.

---

## 3. Integration with Entity State

### 3.1 State definition

Value objects are used as column factories in entity state, identical to `integer()` or `text()`:

```ts
const order = defineEntity('order', {
  state: {
    total: Money({ default: Money.usd(0) }),
    tip: Money({ default: Money.usd(0) }),
    customerEmail: Email(),
    status: text({ enum: ['draft', 'placed', 'paid'] as const }),
  },

  transitions: {
    draft: ['placed'],
    placed: ['paid'],
    paid: [],
  },

  handlers: {
    addItem(state, price: Money.T) {
      return { total: Money.add(state.total, price) };
    },

    setTip(state, tip: Money.T) {
      return { tip };
    },

    place(state) {
      if (Money.isZero(state.total)) {
        throw new EntityError('EMPTY_ORDER', 'Cannot place empty order');
      }
      return { status: 'placed' as const };
    },
  },
});
```

### 3.2 Framework enforcement at handler boundaries

| Boundary | Enforcement |
|----------|-------------|
| **Handler args** (inbound from wire) | Values are validated against invariant + re-branded before the handler runs. Invalid args are rejected with a framework error. |
| **Handler return** (outbound state) | Every value object column in the returned state is validated. If a handler produces invalid state, the framework throws before persisting. |
| **Client-side optimistic update** | `rebase()` re-runs handlers locally. Value object validation runs on the client — same pure functions, same invariants. |
| **NATS deserialization** (state subscription) | When entity state arrives on the client via NATS, value object columns are re-branded and re-validated from plain JSON. |

### 3.3 Handler arg types

`Money.T` in a handler signature is the branded type. The framework uses the type information at the wire boundary to validate inbound args:

```ts
// This works — branded value
entity.addItem(Money.usd(1999));

// Compile error — plain object, missing brand
entity.addItem({ amount: 1999, currency: 'USD' });

// Compile error — wrong value object type
entity.addItem(Email.from('test@example.com'));
```

---

## 4. Integration with Tables

Value objects work as column factories in table schemas:

```ts
const lineItems = table({
  id: id(),
  orderId: OrderId(),
  price: Money(),
  description: text(),
});
```

### 4.1 Storage strategy

| Form | SQLite storage | Merge strategy |
|------|---------------|----------------|
| Composite (Money) | `TEXT` column, JSON-encoded (`{"amount":1999,"currency":"USD"}`) | LWW on the whole object — atomic unit |
| Scalar (Email, UserId) | Native column type (`TEXT`, `INTEGER`) | Inherits from underlying column (default LWW) |

Composite values are atomic — the entire object is the unit of merge. There is no way to LWW on `amount` independently of `currency`. This is correct semantics: a value object has no independently-mutable parts.

### 4.2 Client-side queries

`useTable()` returns rows with branded value types:

```ts
const items = useTable(lineItems);
items.forEach(item => {
  // item.price is Money.T, not a raw object
  console.log(Money.format(item.price));  // "USD 19.99"
  console.log(item.orderId);              // OrderId.T, not string
});
```

### 4.3 Table inserts via effects

Value objects in `insert()` effects are validated before persisting:

```ts
handlers: {
  addToInbox(state, description: string, price: Money.T) {
    return emit({
      state,
      effects: [
        insert(lineItems, {
          orderId: OrderId.from(state.id),  // branded
          price,                             // already Money.T
          description,
        }),
      ],
    });
  },
}
```

---

## 5. Integration with Bus

Value objects participate in bus payload validation via `.zod`:

```ts
const orderEvents = bus('order-events', {
  schema: z.object({
    orderId: OrderId.zod,
    total: Money.zod,
    action: z.enum(['placed', 'paid', 'cancelled']),
  }),
  retention: days(30),
  delivery: 'fanout',
});
```

`Money.zod` returns a Zod schema that validates the shape and invariant. On the bus consumer side, deserialized payloads have branded types:

```ts
// Consumer receives Money.T, not plain object
orderEvents.subscribe((event) => {
  console.log(Money.format(event.total));  // branded
});
```

---

## 6. Nesting

Value objects can contain other value objects:

```ts
const Price = defineValue('price', {
  amount: Money(),
  taxRate: real(),
}, {
  invariant: (v) => v.taxRate >= 0 && v.taxRate <= 1,

  create: {
    withTax: (money: Money.T, rate: number) => ({ amount: money, taxRate: rate }),
  },

  ops: {
    total: (p) => Money.scale(p.amount, 1 + p.taxRate),
  },
});
```

Invariants compose: when constructing a `Price`, the framework validates the inner `Money` first, then the `Price` invariant. Serialization nests naturally — `Price` serializes as `{"amount":{"amount":1999,"currency":"USD"},"taxRate":0.08}`.

---

## 7. Equality

Equality is auto-derived from the value object's shape. No user code needed.

```ts
const a = Money.usd(1999);
const b = Money.usd(1999);
const c = Money.eur(1999);

Money.equals(a, b)  // true — same shape, same values
Money.equals(a, c)  // false — different currency
```

For composites: deep structural comparison of all fields.
For scalars: strict equality of the underlying primitive.
For nested value objects: recursive equality using each nested type's `.equals()`.

---

## 8. Type Guard

`Money.is(x)` is a runtime type guard that checks shape conformance + invariant:

```ts
function processPayment(input: unknown) {
  if (Money.is(input)) {
    // input is Money.T here
    console.log(Money.format(input));
  }
}
```

For composites: checks that all fields exist with correct types, then runs invariant.
For scalars: checks underlying type, then runs invariant.

---

## 9. Testing Escape Hatch

`Money.unsafe()` constructs a branded value without running the invariant. For test fixtures that need to create invalid states to verify error paths:

```ts
// In tests — create deliberately invalid values
const negativeMoney = Money.unsafe({ amount: -100, currency: 'USD' });

// Verify that the handler rejects it at the boundary
expect(() => order.addItem(negativeMoney)).toThrow();
```

`unsafe` is available at runtime but should only be used in tests. The naming signals intent.

---

## 10. File Location

Value objects live alongside schema definitions, since they extend the column type system:

```
src/
  schema.ts              <- tables, views, columns
  values.ts              <- defineValue() definitions (NEW)
  values/                <- or a directory for larger apps
    money.ts
    email.ts
    ids.ts
  db.ts                  <- store({ tables, views })
  entities/
  workflows/
  ...
```

Value objects are plain imports — no Vite plugin discovery needed. Unlike entities and workflows (which require server-side compilation), value objects are pure TypeScript with no runtime wiring. They're consumed by importing them into entity state definitions, table schemas, or bus schemas.

---

## 11. Implementation Surface

### 11.1 packages/core/src/value.ts (NEW)

The core primitive. Pure TypeScript, no runtime dependencies.

- `defineValue()` function — overloaded for composite vs. scalar forms
- `ValueDef<T>` type — the return type, a callable with factories/ops/equality/guard/zod
- Brand symbol management — one `unique symbol` per value object name
- Invariant runner — validates shape + user invariant
- Op wrapper — detects self-returning ops and re-validates
- Zod schema derivation — builds a `z.ZodType` from the column shape + invariant
- `ColumnDef` factory — `.column()` internal that `Money()` delegates to

### 11.2 packages/core/src/schema.ts (MODIFY)

- Add `'value'` to `ColumnKind` union
- Extend `ColumnDef` to carry value object metadata (brand symbol, invariant ref, nested value refs) for composite columns
- Scalar value columns reuse existing column kinds — no schema change needed

### 11.3 packages/core/src/entity.ts (MODIFY)

- `applyHandler` validates value object columns in handler return values
- Handler arg validation at the wire boundary (inbound deserialization)
- Extend `EntityStateShape` to accept value object column defs

### 11.4 packages/server/src/entity-runtime.ts (MODIFY)

- Inbound handler arg validation — deserialize + brand + validate before handler runs
- Outbound state validation — validate value object columns after handler returns
- NATS broadcast — value objects serialize as plain JSON (brand symbol is invisible)

### 11.5 packages/client/src/entity-client.ts (MODIFY)

- NATS subscription deserialization — re-brand + re-validate value object columns
- Optimistic update path — value object validation in `rebase()`

### 11.6 packages/client/src/store.ts (MODIFY)

- `useTable()` deserialization — JSON-parse composite value columns, re-brand
- Table insert validation — validate value object columns before CRDT insert

### 11.7 packages/core/src/index.ts (MODIFY)

- Export `defineValue` and related types

---

## 12. Non-Goals

- **Value object inheritance** — no `extends` between value objects. Use nesting instead.
- **Mutable value objects** — value objects are always immutable. Ops return new values.
- **Value objects as entity keys** — entity keys remain plain strings. A scalar value object can be used as a key by unwrapping, but the framework doesn't enforce branding on keys.
- **Custom serialization formats** — value objects serialize to JSON. No MessagePack, Protobuf, or custom wire formats.
- **Merge strategies for composite sub-fields** — composite values are atomic. The whole object merges as one unit (LWW). Per-sub-field merge is not supported.
