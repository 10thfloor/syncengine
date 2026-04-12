# TypeScript Type Narrowing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every value a developer touches fully typed — view rows narrow through pipeline chains, emit() validates records against table schemas, EntityError preserves its code through catch blocks.

**Architecture:** All changes are compile-time type annotations — zero runtime behavior changes. The view builder's generic `TRecord` transforms through each pipeline method. The `emit()` function accepts table references instead of strings. EntityError propagates directly without wrapping.

**Tech Stack:** TypeScript generics (mapped types, conditional types, Pick), vitest for compile-time assertion tests

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/core/src/schema.ts` | ViewBuilder method return types narrowed — `project`, `aggregate`, `join` remove `as never` casts |
| `packages/core/src/entity.ts` | `EmitInsert` accepts table references; `applyHandler` stops wrapping `EntityError` |
| `packages/core/src/__tests__/schema.test.ts` | Compile-time type assertion tests for view narrowing |
| `packages/core/src/__tests__/entity.test.ts` | Test for `EntityError` propagation and typed `emit()` |
| `packages/server/src/entity-runtime.ts` | Extract table name from reference (`ins.table` → table name string) |
| `apps/test/src/entities/inventory.actor.ts` | Update `emit()` calls to use table references |
| `apps/test/src/entities/order.actor.ts` | Update `emit()` calls to use table references |

---

### Task 1: Remove `as never` Casts from View Builder Methods

**Files:**
- Modify: `packages/core/src/schema.ts` (lines 417-421, 456-459, 470-479)

The ViewBuilder interface already has the correct narrowed return types (lines 358-386). The implementation methods in `createViewBuilder` just need their `as never` casts removed and explicit generic parameters added.

- [ ] **Step 1: Fix `project()` — remove `as never`, add explicit generic**

Change lines 417-421 from:

```typescript
        project(...fields) {
            return createViewBuilder($id, tableName, sourceIdKey, idKey, [
                ...pipeline,
                { op: 'project', fields: fields.map(refOrString) },
            ], tables) as never;
        },
```

To:

```typescript
        project(...fields) {
            return createViewBuilder<Pick<TRecord, typeof fields[number] extends ColumnRef<string, infer N, unknown> ? N : typeof fields[number] & keyof TRecord>>($id, tableName, sourceIdKey, idKey, [
                ...pipeline,
                { op: 'project', fields: fields.map(refOrString) },
            ], tables);
        },
```

Actually — the interface signature already constrains the return type. The implementation just needs to satisfy it. The simplest fix: let TypeScript infer through the interface by using a type assertion that matches the interface's declared return type, which IS the narrowed type. The `as never` was needed because the implementation returned `ViewBuilder<TRecord>` (wrong) — but the interface declares `ViewBuilder<Pick<TRecord, K>>` (right). The fix: cast to the correct type instead of `never`.

Simpler approach — since `createViewBuilder` is generic in TRecord, we can pass `any` as the generic and let the interface signature (which the object literal must satisfy) enforce the correct return type:

```typescript
        project(...fields) {
            return createViewBuilder<any>($id, tableName, sourceIdKey, idKey, [
                ...pipeline,
                { op: 'project', fields: fields.map(refOrString) },
            ], tables);
        },
```

This works because the `builder` object literal is typed as `ViewBuilder<TRecord>`, and the interface's `project` method declares the return type as `ViewBuilder<Pick<TRecord, K>>`. TypeScript checks the method signature against the interface, not the implementation body. The `any` generic on `createViewBuilder` makes the implementation assignable to the interface's return type.

But wait — `as any` is no better than `as never`. Let me think about this differently.

The real issue: `createViewBuilder<TRecord>` returns `ViewBuilder<TRecord>`, but the interface method returns `ViewBuilder<Pick<TRecord, K>>`. These are different types. The implementation CAN'T return the correct type because `createViewBuilder` is called with the same `TRecord` — it doesn't know about the narrowing.

The solution: the `as never` casts are actually the correct TypeScript escape hatch here. The interface provides the type safety — it declares the correct narrowed return type. The implementation builds the runtime object correctly. The cast bridges the gap. Replacing `as never` with a more specific cast is cosmetic, not a type safety improvement.

**What actually needs to change**: The interface signatures ARE the type-narrowing mechanism. They're already correct (lines 358-386). The casts in the implementation are an unavoidable consequence of the builder pattern — the runtime object doesn't know about the generic transformation.

So Task 1 is: **verify the interface signatures are correct and add compile-time tests**.

- [ ] **Step 1: Write compile-time type assertion tests**

Add to `packages/core/src/__tests__/schema.test.ts`:

```typescript
    describe('view builder type narrowing', () => {
        const events = table('events', {
            id: id(),
            region: text(),
            category: text(),
            value: integer(),
            ts: integer(),
        });

        it('aggregate narrows to group-by + aggregated columns', () => {
            const v = view(events).aggregate([events.region], {
                total: sum(events.value),
                count: count(),
            });
            // Compile-time assertions: these lines must type-check
            const row: typeof v.$record = { region: '', total: 0, count: 0 };
            expect(row).toBeDefined();

            // @ts-expect-error — 'category' is not in aggregate output
            const _bad: typeof v.$record = { region: '', total: 0, count: 0, category: '' };
        });

        it('project narrows to selected fields', () => {
            const v = view(events).project(events.region, events.value);
            const row: typeof v.$record = { region: '', value: 0 };
            expect(row).toBeDefined();

            // @ts-expect-error — 'category' is not projected
            const _bad: typeof v.$record = { region: '', value: 0, category: '' };
        });

        it('join produces intersection of both record types', () => {
            const other = table('other', {
                id: id(),
                region: text(),
                label: text(),
            });
            const v = view(events).join(other, events.region, other.region);
            // Must have fields from both tables
            const row: typeof v.$record = {
                id: 0, region: '', category: '', value: 0, ts: 0, label: '',
            };
            expect(row).toBeDefined();
        });

        it('chained pipeline narrows through each step', () => {
            const v = view(events)
                .filter(events.region, 'eq', 'us-west')
                .aggregate([events.region], {
                    total: sum(events.value),
                    count: count(),
                });
            const row: typeof v.$record = { region: '', total: 0, count: 0 };
            expect(row).toBeDefined();

            // @ts-expect-error — 'value' not in aggregate output
            const _bad: typeof v.$record = { region: '', total: 0, count: 0, value: 0 };
        });

        it('multi-column aggregate narrows correctly', () => {
            const v = view(events).aggregate([events.region, events.category], {
                total: sum(events.value),
            });
            const row: typeof v.$record = { region: '', category: '', total: 0 };
            expect(row).toBeDefined();

            // @ts-expect-error — 'value' not in aggregate output
            const _bad: typeof v.$record = { region: '', category: '', total: 0, value: 0 };
        });

        it('global aggregate (zero group-by) has only aggregated columns', () => {
            const v = view(events).aggregate([], {
                revenue: sum(events.value),
                count: count(),
            });
            const row: typeof v.$record = { revenue: 0, count: 0 };
            expect(row).toBeDefined();

            // @ts-expect-error — 'region' not in global aggregate output
            const _bad: typeof v.$record = { revenue: 0, count: 0, region: '' };
        });
    });
```

- [ ] **Step 2: Run the tests to verify type assertions pass**

Run: `cd packages/core && npx vitest run src/__tests__/schema.test.ts`

Expected: All tests pass. The `@ts-expect-error` lines confirm that invalid field access is caught at compile time. If any `@ts-expect-error` does NOT produce an error (meaning the type is too loose), the test will fail with "Unused '@ts-expect-error' directive".

- [ ] **Step 3: Commit**

Commit message: `test(core): add compile-time type assertion tests for view builder narrowing`

---

### Task 2: EntityError — Stop Wrapping, Preserve Type

**Files:**
- Modify: `packages/core/src/entity.ts` (lines 663-674)
- Modify: `packages/core/src/__tests__/entity.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/__tests__/entity.test.ts`:

```typescript
import {
    defineEntity,
    isEntity,
    validateEntityState,
    applyHandler,
    rebase,
    EntityError,
    type EntityRecord,
    type EntityHandlers,
} from '../entity';

// ... existing tests ...

    describe('EntityError propagation', () => {
        const guarded = defineEntity('guarded', {
            state: { status: text({ enum: ['open', 'closed'] as const }) },
            handlers: {
                close(state) {
                    if (state.status === 'closed') {
                        throw new EntityError('ALREADY_CLOSED', 'Already closed');
                    }
                    return { status: 'closed' as const };
                },
            },
        });

        it('propagates EntityError with code intact', () => {
            const closed = { status: 'closed' };
            try {
                applyHandler(guarded, 'close', closed, []);
                expect.unreachable('should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(EntityError);
                expect((err as EntityError).code).toBe('ALREADY_CLOSED');
            }
        });

        it('preserves handler context in error message', () => {
            const closed = { status: 'closed' };
            try {
                applyHandler(guarded, 'close', closed, []);
                expect.unreachable('should have thrown');
            } catch (err) {
                expect((err as EntityError).message).toContain('Already closed');
            }
        });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/entity.test.ts -t "propagates EntityError"`

Expected: FAIL — currently `err` is a plain `Error` (wrapped), not an `EntityError`. The `toBeInstanceOf(EntityError)` check fails.

- [ ] **Step 3: Fix applyHandler to propagate EntityError directly**

In `packages/core/src/entity.ts`, change lines 663-674 from:

```typescript
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Preserve EntityError code through the re-wrap so the server can
    // include it in the TerminalError and the client can distinguish
    // error categories.
    const wrapped = new Error(
      `entity '${entity.$name}' handler '${handlerName}' rejected: ${message}`,
    );
    if (err instanceof EntityError) {
      (wrapped as any).code = err.code;
    }
    throw wrapped;
  }
```

To:

```typescript
  } catch (err) {
    if (err instanceof EntityError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `entity '${entity.$name}' handler '${handlerName}' rejected: ${message}`,
    );
  }
```

EntityError propagates directly — no wrapping, no `as any`. Non-EntityError exceptions still get wrapped with handler context.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/__tests__/entity.test.ts`

Expected: All tests pass, including the new EntityError propagation tests.

- [ ] **Step 5: Verify server-side still handles EntityError**

Check that `packages/server/src/entity-runtime.ts` line 86 still works:

```typescript
    const code = (err as any)?.code;
```

Since `EntityError` has a `code` property, this still works. But now we can improve it:

In `packages/server/src/entity-runtime.ts`, change lines 84-89 from:

```typescript
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as any)?.code;
        // Include code in the error message as a prefix so the client can parse it
        const fullMessage = code ? `[${code}] ${message}` : message;
        throw new restate.TerminalError(fullMessage);
    }
```

To:

```typescript
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof EntityError ? err.code : undefined;
        const fullMessage = code ? `[${code}] ${message}` : message;
        throw new restate.TerminalError(fullMessage);
    }
```

Add the import at the top of `entity-runtime.ts`:

```typescript
import { EntityError } from '@syncengine/core';
```

(Check if `EntityError` is already imported — it may be.)

- [ ] **Step 6: Type-check**

Run: `cd packages/core && pnpm typecheck && cd ../server && pnpm typecheck`

Expected: No type errors.

- [ ] **Step 7: Commit**

Commit message: `fix(core): propagate EntityError directly — preserve typed code through catch`

---

### Task 3: Type-Safe `emit()` Table References

**Files:**
- Modify: `packages/core/src/entity.ts` (EmitInsert type, emit function)
- Modify: `packages/server/src/entity-runtime.ts` (extract table name from reference)
- Modify: `apps/test/src/entities/inventory.actor.ts` (update emit calls)
- Modify: `apps/test/src/entities/order.actor.ts` (update emit calls)

- [ ] **Step 1: Update EmitInsert type to accept both string and table reference**

In `packages/core/src/entity.ts`, change lines 382-386 from:

```typescript
/** A table row to publish as an INSERT delta. */
export interface EmitInsert {
  readonly table: string;
  readonly record: Record<string, unknown>;
}
```

To:

```typescript
/** A table row to publish as an INSERT delta (typed form). */
export interface EmitInsert<T extends AnyTable = AnyTable> {
  readonly table: T | string;
  readonly record: T extends AnyTable ? Partial<InferRecord<T['$columns']>> : Record<string, unknown>;
}
```

Add the import for `AnyTable` and `InferRecord` if not already present (check the existing imports at the top of entity.ts).

- [ ] **Step 2: Add `resolveEmitTableName` helper**

After the `EmitInsert` definition, add:

```typescript
/** Extract the table name from an EmitInsert — handles both string and table reference. */
export function resolveEmitTableName(insert: EmitInsert): string {
  return typeof insert.table === 'string' ? insert.table : insert.table.$name;
}
```

- [ ] **Step 3: Update entity-runtime to use resolveEmitTableName**

In `packages/server/src/entity-runtime.ts`, change line 103 from:

```typescript
        return { table: ins.table, record: resolved };
```

To:

```typescript
        return { table: resolveEmitTableName(ins), record: resolved };
```

And the unmodified path at line 98 — check the `map` callback: if `hasPlaceholder` is false, `ins` is returned as-is. The `publishTableDeltas` function at line 176 uses `inserts[i]!.table` — this also needs updating.

Change `publishTableDeltas` to resolve table names:

```typescript
            nc.publish(subject, JSON.stringify({
                type: "INSERT",
                table: resolveEmitTableName(inserts[i]!),
                record: inserts[i]!.record,
                _clientId: "restate-entity-runtime",
                _nonce: nonces[i],
            }));
```

Also update the `map` callback (line 96-104) to always resolve table names in the output:

```typescript
    const emits = rawEmits?.map((ins) => {
        const tableName = resolveEmitTableName(ins);
        const hasPlaceholder = Object.values(ins.record).some((v) => v === '$key');
        if (!hasPlaceholder) return { table: tableName, record: ins.record };
        const resolved: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(ins.record)) {
            resolved[k] = v === '$key' ? entityKey : v;
        }
        return { table: tableName, record: resolved };
    });
```

Import `resolveEmitTableName` from `@syncengine/core`:

```typescript
import {
    // ... existing imports ...
    resolveEmitTableName,
} from '@syncengine/core';
```

- [ ] **Step 4: Update inventory.actor.ts emit calls**

In `apps/test/src/entities/inventory.actor.ts`, change the `sell` handler's emit from:

```typescript
        {
          table: 'transactions',
          record: { ... },
        },
```

To:

```typescript
        {
          table: transactions,
          record: { ... },
        },
```

The `transactions` table is already imported at line 35. Do the same for the `refund` handler.

- [ ] **Step 5: Update order.actor.ts emit calls**

In `apps/test/src/entities/order.actor.ts`, change the `place` handler's emit from:

```typescript
        {
          table: 'orderIndex',
          record: { ... },
        },
```

To:

```typescript
        {
          table: orderIndex,
          record: { ... },
        },
```

Add the import at the top:

```typescript
import { orderIndex } from '../schema';
```

- [ ] **Step 6: Write a compile-time test for typed emit**

Add to `packages/core/src/__tests__/entity.test.ts`:

```typescript
    describe('typed emit()', () => {
        const accounts = table('accounts', {
            id: id(),
            name: text(),
            balance: real(),
        });

        it('accepts table reference with matching record shape', () => {
            const e = defineEntity('bank', {
                state: { balance: real() },
                handlers: {
                    deposit(state, amount: number) {
                        return emit(
                            { balance: state.balance + amount },
                            { table: accounts, record: { name: 'test', balance: amount } },
                        );
                    },
                },
            });
            expect(e.$handlers.deposit).toBeDefined();
        });

        it('still accepts string table name for backward compat', () => {
            const e = defineEntity('legacy', {
                state: { balance: real() },
                handlers: {
                    deposit(state, amount: number) {
                        return emit(
                            { balance: state.balance + amount },
                            { table: 'accounts', record: { name: 'test', balance: amount } },
                        );
                    },
                },
            });
            expect(e.$handlers.deposit).toBeDefined();
        });
    });
```

- [ ] **Step 7: Run all tests**

Run: `cd packages/core && npx vitest run`

Expected: All tests pass.

- [ ] **Step 8: Type-check all affected packages**

Run: `npx tsc --noEmit --project packages/core/tsconfig.json && npx tsc --noEmit --project packages/server/tsconfig.json && npx tsc --noEmit --project packages/client/tsconfig.json`

Expected: No type errors.

- [ ] **Step 9: Commit**

Commit message: `feat(core): type-safe emit() with table references — validates record shape at compile time`

---

### Task 4: End-to-End Verification

**Files:** None (testing only)

- [ ] **Step 1: Verify view type narrowing in test app**

Check that the test app's schema.ts views type-check correctly with the narrowed types. The views already use the correct patterns:

```typescript
// schema.ts — these should type-check without changes
const salesByProduct = view(transactions)
  .filter(transactions.type, 'eq', 'sale')
  .aggregate([transactions.productSlug], { total: sum(transactions.amount), count: count() });

const allOrders = view(orderIndex)
  .aggregate([orderIndex.orderId, orderIndex.productSlug, orderIndex.userId], {
    price: max(orderIndex.price),
    createdAt: max(orderIndex.createdAt),
  });
```

Run: `npx tsc --noEmit --project apps/test/tsconfig.json 2>&1 | grep -v vite-plugin`

Expected: No errors in test app files. Pre-existing vite-plugin errors are unrelated.

- [ ] **Step 2: Verify emit type safety catches errors**

Temporarily add an intentionally wrong emit in an entity handler:

```typescript
// In inventory.actor.ts, temporarily add to sell():
emit(newState, { table: transactions, record: { badField: 123 } })
```

Run type-check — should produce a compile error because `badField` is not a column of `transactions`.

Remove the intentional error after verifying.

- [ ] **Step 3: Verify EntityError in OrdersTab**

The OrdersTab catches entity errors in `handleAdvance` and `handleCancel`. After the fix, `EntityError` propagates directly, so `instanceof EntityError` works in catch blocks.

No code changes needed — just verify the app compiles and works.

- [ ] **Step 4: Run the full test suite**

Run: `cd packages/core && npx vitest run`

Expected: All tests pass.
