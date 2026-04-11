# Testing Harness — In-Process DBSP Test Engine

**Date:** 2026-04-15
**Status:** Draft
**Scope:** New package `@syncengine/test`, test app examples

## Summary

A lightweight test engine that runs the DBSP WASM module in-process (Node.js, no worker, no NATS, no SQLite). Developers write vitest tests that insert rows, read materialized views, and verify entity handler outputs — all in microseconds after the one-time WASM load.

## Goals

- Test view pipelines without infrastructure
- Test entity handler sequences (state transitions + emits)
- Use the real DBSP WASM engine (same code path as production)
- Sub-second test execution after WASM cold start

## Non-Goals

- Network/transport testing (NATS, gateway, WebSocket)
- SQLite persistence testing
- React hook testing (useSyncExternalStore)
- Multi-client concurrency testing

---

## API

```typescript
import { createTestStore } from '@syncengine/test';
import { products, transactions, salesByProduct } from './schema';
import { inventory } from './entities/inventory.actor';

const t = createTestStore({
  tables: [products, transactions],
  views: { salesByProduct },
});

// Insert rows
t.insert(transactions, { productSlug: 'keyboard', amount: 79, type: 'sale', timestamp: 1 });

// Read materialized view
expect(t.view(salesByProduct)).toEqual([
  { productSlug: 'keyboard', total: 79, count: 1 },
]);

// Delete rows
t.delete(transactions, rowId);

// Entity handler + emit into pipeline
const result = t.applyHandler(inventory, 'sell', currentState, [userId, orderId, price, now]);
// result.state — the new entity state
// result.emits — the EmitInsert[] from emit()

t.applyEmits(result.emits, 'headphones');  // second arg = entity key, resolves '$key' placeholders
// Now the emitted rows are in the pipeline — views update

// Typed view output
const rows: { productSlug: string; total: number; count: number }[] = t.view(salesByProduct);

// Reset all state
t.reset();
```

## Architecture

`createTestStore` creates an in-process instance of the DBSP WASM engine with the same view pipeline definitions the real store uses. No worker thread, no message passing, no SQLite. The engine's `step()` function processes deltas synchronously and returns view updates.

### Internal Flow

```
t.insert(table, record)
  → build delta: { source: tableName, record, weight: +1 }
  → dbsp.step([delta])
  → update internal view snapshots from step output
  → return void (views updated in place)

t.view(viewDef)
  → look up viewDef.$id in internal snapshot map
  → return frozen array of current rows

t.applyHandler(entity, handlerName, state, args)
  → call applyHandler(entity, handlerName, state, args) from @syncengine/core
  → extract emits via extractEmits()
  → return { state, emits }
  → does NOT insert emits into pipeline (caller decides)

t.applyEmits(emits, entityKey?)
  → for each emit: resolve '$key' placeholders to entityKey if provided
  → for each emit: t.insert(emit.table, emit.record)
  → resolves table name from string or table reference

t.delete(table, id)
  → look up existing row by id in internal row store (Map<tableName, Map<id, Record>>)
  → if not found, throw (can't retract a row that doesn't exist)
  → build delta: { source: tableName, record: existingRow, weight: -1 }
  → remove from internal row store
  → dbsp.step([delta])
  → update view snapshots

t.reset()
  → dbsp.reset()
  → clear all internal state (row store, view snapshots)
```

### View Snapshot Tracking

The test engine maintains an internal `Map<viewName, Map<recordId, Record>>` (same pattern as the store's `viewMaps`). After each `step()`, deltas with `weight > 0` upsert, `weight < 0` delete. The `t.view()` method returns `[...map.values()]`.

The `recordId` computation uses the same `$idKey` logic from the view builder (single string, composite array, or `GLOBAL_AGG_KEY`).

### Internal Row Store

The test engine maintains `Map<tableName, Map<id, Record>>` — a copy of every row inserted, keyed by table name and PK value. This serves two purposes:
1. `t.delete(table, id)` needs the full row to build a retraction delta
2. Prevents double-inserts with the same PK (upsert semantics, matching SQLite INSERT OR REPLACE)

### Merge Config Registration

If tables have merge configs (CRDV fields with `lww`, `max`, etc.), the test engine calls `dbsp.register_merge()` during construction — same as the real worker. The merge configs are extracted from the table definitions via `extractMergeConfig()` from `@syncengine/core`.

### Typed View Output

`t.view(viewDef)` returns `readonly ViewRecord<typeof viewDef>[]` — the type is inferred from the view builder's `$record` phantom type. After the type narrowing work, this means aggregate views return only the group-by + aggregated columns.

### WASM Loading

The `@sqlite.org/sqlite-wasm` module is NOT needed — the test engine only uses `@syncengine/dbsp` (the DBSP WASM engine). This loads in ~50ms in Node.js. The module is cached across test files via vitest's module cache.

### Auto-Generated IDs

When inserting a row without an `id` field (the PK), the test engine auto-generates a monotonically increasing integer. This matches the real store's `synthesizeId()` behavior.

---

## Package Structure

```
packages/test-utils/
  package.json          — @syncengine/test-utils, depends on @syncengine/core + @syncengine/dbsp
  src/
    index.ts            — exports createTestStore
    test-store.ts       — TestStore class implementation
```

The existing `packages/test/` is a test runner package — the new package is `packages/test-utils/` to avoid confusion.

---

## File Inventory

| File | Change |
|------|--------|
| `packages/test-utils/package.json` | New package |
| `packages/test-utils/src/index.ts` | Export `createTestStore` |
| `packages/test-utils/src/test-store.ts` | `TestStore` class — DBSP engine wrapper, insert/delete/view/applyHandler/applyEmits/reset |
| `packages/test-utils/src/__tests__/test-store.test.ts` | Tests for the test store itself |
| `apps/test/src/__tests__/views.test.ts` | Example: test app view pipeline verification |
| `apps/test/src/__tests__/entities.test.ts` | Example: entity handler + emit round-trip |
