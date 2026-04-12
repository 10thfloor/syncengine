# End-to-End TypeScript Type Narrowing

**Date:** 2026-04-15
**Status:** Draft
**Scope:** `@syncengine/core` (schema.ts, entity.ts), zero runtime changes

## Summary

Three type-system improvements to the developer-facing API. All changes are compile-time only — no runtime behavior changes. The goal is that every value a developer touches (view rows, entity emit records, entity errors) is fully typed with no `unknown` or `any` leaking through.

## Goals

- View builder chain narrows `TRecord` through `.project()`, `.aggregate()`, `.join()`
- `emit()` validates the record shape against the target table schema at compile time
- `EntityError` preserves its typed `code` field through catch blocks

## Non-Goals

- Converting `data-worker.js` to TypeScript (internal, developers never import it)
- Typing internal NATS connections (internal plumbing)
- Typing the worker↔store message protocol (internal, already correct at the public API surface)

---

## 1. View Builder Type Narrowing

### Problem

Every pipeline method returns `createViewBuilder<TRecord>` with the same `TRecord` as the source table. After `.aggregate(['category'], { total: sum(amount) })`, the phantom `$record` type still includes all source columns instead of just `{ category: string, total: number }`. The `as never` casts on `project`, `aggregate`, and `join` returns suppress the resulting type errors.

### Design

Each pipeline method transforms `TRecord` at the type level:

```typescript
// filter: no shape change
filter(field, op, value): ViewBuilder<TRecord>

// project: narrow to selected fields
project<K extends (keyof TRecord & string)[]>(
  ...fields: K
): ViewBuilder<Pick<TRecord, K[number]>>

// aggregate: group-by cols (from TRecord) + aggregated cols (always number)
aggregate<
  GK extends (keyof TRecord & string)[],
  AGG extends Record<string, AggregateSpec>,
>(
  groupBy: GK,
  aggs: AGG,
): ViewBuilder<Pick<TRecord, GK[number]> & { [K in keyof AGG]: number }>

// topN: no shape change
topN(sortBy, limit, order): ViewBuilder<TRecord>

// join: intersection of left + right record types
join<RTable extends AnyTable>(
  right: RTable, lk, rk
): ViewBuilder<TRecord & InferRecord<RTable['$columns']>>

// distinct: no shape change
distinct(): ViewBuilder<TRecord>
```

### What Changes

**`createViewBuilder` signature** — the `TRecord` generic is already threaded through. The only change is making each method return the correctly narrowed generic instead of casting to `as never`.

**`ViewBuilder` interface** — each method's return type changes from `ViewBuilder<TRecord>` to the narrowed variant shown above.

**`$idKey` propagation** — `aggregate` already sets `$idKey` correctly (single column, composite array, or `GLOBAL_AGG_KEY`). No change needed.

**ColumnRef consumption** — the `refOrString` helper extracts the column name string from a `ColumnRef`. The aggregate/project/filter methods already use this. The type narrowing uses `keyof TRecord & string` which aligns with the extracted names.

### What Doesn't Change

- Runtime behavior — all changes are type annotations
- Pipeline execution in the DBSP WASM engine — it receives the same `pipeline` array
- `$idKey` / `$sourceIdKey` logic — already correct from the composite key fix
- `filter` and `topN` — these don't change the record shape

### Developer Experience After

```typescript
const salesByProduct = view(transactions)
  .filter(transactions.type, 'eq', 'sale')
  .aggregate([transactions.productSlug], {
    total: sum(transactions.amount),
    count: count(),
  });

// salesByProduct.$record is now:
// { productSlug: string, total: number, count: number }
// (was: full transactions record type)

const { views } = db.use({ salesByProduct });
views.salesByProduct[0].total;        // number ✓
views.salesByProduct[0].productSlug;  // string ✓
views.salesByProduct[0].userId;       // ✗ compile error (not in aggregate output)
```

---

## 2. Type-Safe `emit()` Table Reference

### Problem

`emit()` accepts `{ table: string, record: Record<string, unknown> }`. The developer can emit to a nonexistent table or with a record that doesn't match the target table's columns — no compile-time error, only runtime failure.

### Design

Make `emit()` accept a table reference instead of a string, and infer the record type from it:

```typescript
// Before
emit(newState, { table: 'transactions', record: { productSlug: '$key', amount: price, ... } })

// After — same call syntax, but typed
emit(newState, { table: transactions, record: { productSlug: '$key', amount: price, ... } })
```

The `EmitInsert` type changes from:

```typescript
interface EmitInsert {
  readonly table: string;
  readonly record: Record<string, unknown>;
}
```

To a generic that infers the record shape from the table:

```typescript
interface EmitInsert<T extends AnyTable = AnyTable> {
  readonly table: T;
  readonly record: Partial<InferRecord<T['$columns']>>;
}
```

`Partial` is used because some fields may use `'$key'` (entity key placeholder) or be auto-generated (`id`). The framework resolves `'$key'` at runtime — TypeScript can't validate that a string `'$key'` matches a specific column type, so `Partial` is the pragmatic choice.

### Migration

Existing code changes from `table: 'transactions'` (string) to `table: transactions` (imported table reference). This is a breaking change for entity definitions that use `emit()`. The migration is mechanical — replace string literals with imports.

The runtime `emit()` function extracts the table name from the reference (`table.$name`) when serializing to the worker. The entity-runtime on the server does the same.

### Backward Compatibility

To avoid a hard break, `emit()` can accept both forms during a transition period:

```typescript
function emit<S>(state: S, ...inserts: (TypedEmitInsert | LegacyEmitInsert)[]): S
```

Where `LegacyEmitInsert` is the old `{ table: string, record: Record<string, unknown> }`. This lets existing code compile while new code gets type checking. The legacy form can be deprecated with a `@deprecated` JSDoc annotation.

---

## 3. `EntityError` Typed Through Catch

### Problem

In `applyHandler()` (entity.ts), when an `EntityError` is caught and re-wrapped, the `code` property is attached via `(wrapped as any).code = err.code`. App developers who catch errors from entity actions can't access `.code` with type safety.

### Design

`EntityError` is already a class exported from `@syncengine/core`. The fix is to stop wrapping it — let the `EntityError` instance propagate directly through the action proxy. If wrapping is necessary for stack trace purposes, extend the wrapped error to preserve the `code` property in its type:

```typescript
// In applyHandler, instead of:
(wrapped as any).code = err.code;

// Either: don't wrap EntityErrors at all
if (err instanceof EntityError) throw err;

// Or: create a typed wrapper
class WrappedEntityError extends Error {
  readonly code: string;
  constructor(original: EntityError) {
    super(original.message);
    this.code = original.code;
    this.cause = original;
  }
}
```

The simpler option (don't wrap) is preferred. `EntityError` already has a proper stack trace from the handler's throw site. Wrapping was only needed to add context about which handler threw — that can go in the `message` instead.

### Developer Experience After

```typescript
try {
  await actions.pack();
} catch (e) {
  if (e instanceof EntityError) {
    console.log(e.code); // 'INVALID_TRANSITION' — fully typed, no cast needed
  }
}
```

---

## File Inventory

| File | Change |
|------|--------|
| `packages/core/src/schema.ts` | View builder method return types narrowed; `aggregate`, `project`, `join` lose `as never` casts |
| `packages/core/src/entity.ts` | `EmitInsert` typed with table reference; `applyHandler` stops wrapping `EntityError` |
| `packages/core/src/__tests__/schema.test.ts` | Tests for view type narrowing (compile-time assertions) |
| `packages/core/src/__tests__/entity.test.ts` | Test for `EntityError` propagation |
| `apps/test/src/entities/*.actor.ts` | `emit()` calls updated from `table: 'string'` to `table: tableRef` |
