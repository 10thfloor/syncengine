# Testing Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-process test engine (`createTestStore`) that runs the DBSP WASM engine directly in vitest — insert rows, read materialized views, and verify entity handler outputs without any infrastructure.

**Architecture:** `TestStore` wraps `DbspEngine` from `@syncengine/dbsp`, maintains an internal row store for delete lookups, and tracks view snapshots using the same composite `$idKey` logic as the real store. Four methods: `insert`, `delete`, `view`, `applyHandler`, plus `applyEmits` and `reset`.

**Tech Stack:** `@syncengine/dbsp` (WASM), `@syncengine/core` (schema DSL, entity handlers), vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/test-utils/package.json` | Package manifest — depends on `@syncengine/core` + `@syncengine/dbsp` |
| `packages/test-utils/tsconfig.json` | TypeScript config |
| `packages/test-utils/src/index.ts` | Single export: `createTestStore` |
| `packages/test-utils/src/test-store.ts` | `TestStore` class — DBSP wrapper, row store, view snapshots |
| `packages/test-utils/src/__tests__/test-store.test.ts` | Self-tests: insert, view, delete, reset, aggregate, entity handler |

---

### Task 1: Create Package Scaffold

**Files:**
- Create: `packages/test-utils/package.json`
- Create: `packages/test-utils/tsconfig.json`
- Create: `packages/test-utils/src/index.ts`

- [ ] **Step 1: Create package.json**

Create `packages/test-utils/package.json`:

```json
{
  "name": "@syncengine/test-utils",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@syncengine/core": "workspace:*",
    "@syncengine/dbsp": "file:../dbsp-engine/pkg"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "~5.9.3",
    "vitest": "^1.0.4"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/test-utils/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "types": ["node"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "declaration": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create index.ts stub**

Create `packages/test-utils/src/index.ts`:

```typescript
export { createTestStore, type TestStore } from './test-store.js';
```

- [ ] **Step 4: Install dependencies**

Run: `pnpm install`

Expected: `@syncengine/test-utils` linked into the workspace.

- [ ] **Step 5: Commit**

Commit message: `feat(test-utils): scaffold @syncengine/test-utils package`

---

### Task 2: Implement TestStore Core (insert + view)

**Files:**
- Create: `packages/test-utils/src/test-store.ts`

- [ ] **Step 1: Implement TestStore class**

Create `packages/test-utils/src/test-store.ts`:

```typescript
import { DbspEngine } from '@syncengine/dbsp';
import {
    type AnyTable,
    type ViewBuilder,
    type AnyEntity,
    type EmitInsert,
    extractMergeConfig,
    applyHandler as coreApplyHandler,
    extractEmits,
    resolveEmitTableName,
    GLOBAL_AGG_KEY,
} from '@syncengine/core';

// ── Types ────────────────────────────────────────────────────────────────

export interface TestStoreConfig {
    tables: readonly AnyTable[];
    views: Record<string, ViewBuilder<unknown>>;
}

export interface HandlerResult {
    state: Record<string, unknown>;
    emits: EmitInsert[];
}

// ── Record ID computation (mirrors store.ts recordId) ────────────────────

function recordId(record: Record<string, unknown>, idKey: string | string[]): string {
    if (Array.isArray(idKey)) {
        return idKey.map((c) => String(record[c] ?? '')).join('|');
    }
    return String(record[idKey]);
}

// ── WASM id_key serialization (mirrors data-worker.js wasmIdKey) ─────────

function wasmIdKey(idKey: string | string[]): string {
    return Array.isArray(idKey) ? idKey.join('|') : idKey;
}

// ── Deep conversion from WASM Map/proxy to plain objects ────────────────

function deepToObject(val: unknown): Record<string, unknown> {
    if (val instanceof Map) {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of val) obj[k] = v;
        return obj;
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val)) {
            obj[k] = v instanceof Map ? deepToObject(v) : v;
        }
        return obj;
    }
    return val as Record<string, unknown>;
}

// ── TestStore ────────────────────────────────────────────────────────────

export class TestStore {
    private readonly dbsp: DbspEngine;
    private readonly tables: ReadonlyMap<string, AnyTable>;
    private readonly views: ReadonlyMap<string, ViewBuilder<unknown>>;
    private readonly viewsByName: ReadonlyMap<string, string>; // display name → $id
    private readonly rowStore = new Map<string, Map<number | string, Record<string, unknown>>>();
    private readonly viewSnapshots = new Map<string, Map<string, Record<string, unknown>>>();
    private nextId = 1;

    constructor(config: TestStoreConfig) {
        // Build table lookup
        const tables = new Map<string, AnyTable>();
        for (const t of config.tables) tables.set(t.$name, t);
        this.tables = tables;

        // Build view lookup
        const views = new Map<string, ViewBuilder<unknown>>();
        const viewsByName = new Map<string, string>();
        for (const [name, v] of Object.entries(config.views)) {
            views.set(v.$id, v);
            viewsByName.set(name, v.$id);
        }
        this.views = views;
        this.viewsByName = viewsByName;

        // Initialize DBSP engine (same shape as data-worker.js handleInit)
        this.dbsp = new DbspEngine(
            Object.entries(config.views).map(([name, v]) => ({
                name,
                source_table: v.$tableName,
                id_key: wasmIdKey(v.$idKey),
                source_id_key: v.$sourceIdKey,
                pipeline: v.$pipeline,
            })),
        );

        // Register merge configs
        for (const t of config.tables) {
            const mc = extractMergeConfig(t);
            if (mc) this.dbsp.register_merge(mc.table, { fields: mc.fields });
        }
    }

    /** Insert a row into a table. Auto-generates PK if missing. */
    insert<T extends AnyTable>(table: T, record: Partial<Record<string, unknown>>): void {
        const tableName = table.$name;
        const idKey = table.$idKey;
        const row = { ...record };

        // Auto-generate PK if not provided
        if (row[idKey] === undefined) {
            row[idKey] = this.nextId++;
        }

        // Upsert into row store
        if (!this.rowStore.has(tableName)) this.rowStore.set(tableName, new Map());
        const tableRows = this.rowStore.get(tableName)!;
        const id = row[idKey] as number | string;

        // If row with same PK exists, retract it first (upsert = delete + insert)
        const existing = tableRows.get(id);
        if (existing) {
            this.step([{ source: tableName, record: existing, weight: -1 }]);
        }

        tableRows.set(id, row as Record<string, unknown>);
        this.step([{ source: tableName, record: row, weight: 1 }]);
    }

    /** Delete a row by PK. Throws if the row doesn't exist. */
    delete<T extends AnyTable>(table: T, id: number | string): void {
        const tableName = table.$name;
        const tableRows = this.rowStore.get(tableName);
        const existing = tableRows?.get(id);
        if (!existing) {
            throw new Error(`TestStore.delete: no row with id=${id} in table '${tableName}'`);
        }
        tableRows!.delete(id);
        this.step([{ source: tableName, record: existing, weight: -1 }]);
    }

    /** Read the current materialized view output. */
    view<T>(viewDef: ViewBuilder<T>): readonly T[] {
        // Look up by $id first, then by display name
        let snap = this.viewSnapshots.get(viewDef.$id);
        if (!snap) {
            // Try display name lookup
            for (const [name, vid] of this.viewsByName) {
                if (vid === viewDef.$id) {
                    snap = this.viewSnapshots.get(name);
                    break;
                }
            }
        }
        if (!snap) return [];
        return Object.freeze([...snap.values()]) as readonly T[];
    }

    /** Run an entity handler. Returns new state + emits. Does NOT insert emits. */
    applyHandler(
        entity: AnyEntity,
        handlerName: string,
        state: Record<string, unknown> | null,
        args: readonly unknown[],
    ): HandlerResult {
        const nextState = coreApplyHandler(entity, handlerName, state, args);
        const emits = extractEmits(nextState) ?? [];
        return { state: nextState, emits };
    }

    /** Insert emits into the pipeline. Resolves '$key' placeholders. */
    applyEmits(emits: readonly EmitInsert[], entityKey?: string): void {
        for (const emit of emits) {
            const tableName = resolveEmitTableName(emit);
            const tableRef = this.tables.get(tableName);
            if (!tableRef) {
                throw new Error(`TestStore.applyEmits: unknown table '${tableName}'`);
            }

            // Resolve '$key' placeholders
            const record = { ...emit.record };
            if (entityKey) {
                for (const [k, v] of Object.entries(record)) {
                    if (v === '$key') record[k] = entityKey;
                }
            }

            this.insert(tableRef, record);
        }
    }

    /** Reset all state (row store + DBSP engine + view snapshots). */
    reset(): void {
        this.dbsp.reset();
        this.rowStore.clear();
        this.viewSnapshots.clear();
        this.nextId = 1;
    }

    // ── Private ──────────────────────────────────────────────────────

    private step(deltas: Array<{ source: string; record: Record<string, unknown>; weight: number }>): void {
        const rawResult = this.dbsp.step(deltas);
        const rawViews = rawResult.views || rawResult;

        const entries: Array<[string, Array<{ record: Record<string, unknown>; weight: number }>]> =
            rawViews instanceof Map
                ? [...rawViews.entries()]
                : Object.entries(rawViews);

        for (const [viewName, viewDeltas] of entries) {
            if (!viewDeltas || viewDeltas.length === 0) continue;

            // Resolve view $id from display name
            const viewId = this.viewsByName.get(viewName) ?? viewName;
            const viewDef = this.views.get(viewId);
            const idKey = viewDef?.$idKey ?? 'id';

            if (!this.viewSnapshots.has(viewName)) {
                this.viewSnapshots.set(viewName, new Map());
            }
            const snap = this.viewSnapshots.get(viewName)!;

            for (const d of viewDeltas) {
                const rec = deepToObject(d.record);
                const rid = recordId(rec, idKey);
                if (d.weight > 0) {
                    snap.set(rid, rec);
                } else {
                    snap.delete(rid);
                }
            }
        }
    }
}

// ── Factory ──────────────────────────────────────────────────────────────

export function createTestStore(config: TestStoreConfig): TestStore {
    return new TestStore(config);
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit --project packages/test-utils/tsconfig.json`

Expected: No type errors.

- [ ] **Step 3: Commit**

Commit message: `feat(test-utils): implement TestStore — DBSP-backed in-process test engine`

---

### Task 3: Self-Tests for TestStore

**Files:**
- Create: `packages/test-utils/src/__tests__/test-store.test.ts`

- [ ] **Step 1: Write tests**

Create `packages/test-utils/src/__tests__/test-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore, type TestStore } from '../index.js';
import {
    table, id, text, integer, real,
    view, sum, count, max,
    entity, emit, EntityError,
} from '@syncengine/core';

// ── Test schema ──────────────────────────────────────────────────────────

const products = table('products', {
    id: id(),
    slug: text(),
    price: real(),
});

const transactions = table('transactions', {
    id: id(),
    productSlug: text(),
    userId: text(),
    amount: real(),
    type: text(),
    timestamp: integer(),
});

const orderIndex = table('orderIndex', {
    id: id(),
    orderId: text(),
    productSlug: text(),
    userId: text(),
    price: real(),
    createdAt: integer(),
});

const salesByProduct = view(transactions)
    .filter(transactions.type, 'eq', 'sale')
    .aggregate([transactions.productSlug], {
        total: sum(transactions.amount),
        count: count(),
    });

const totalSales = view(transactions)
    .aggregate([], {
        revenue: sum(transactions.amount),
        count: count(),
    });

const allOrders = view(orderIndex)
    .aggregate([orderIndex.orderId, orderIndex.productSlug, orderIndex.userId], {
        price: max(orderIndex.price),
        createdAt: max(orderIndex.createdAt),
    });

// ── Test entity ──────────────────────────────────────────────────────────

const inventory = entity('inventory', {
    state: {
        stock: integer(),
    },
    handlers: {
        sell(state, userId: string, price: number, now: number) {
            if (state.stock <= 0) throw new EntityError('OUT_OF_STOCK', 'No stock');
            return emit(
                { ...state, stock: state.stock - 1 },
                { table: transactions, record: { productSlug: '$key', userId, amount: price, type: 'sale', timestamp: now } },
            );
        },
        restock(state, amount: number) {
            return { ...state, stock: state.stock + amount };
        },
    },
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('TestStore', () => {
    let t: TestStore;

    beforeEach(() => {
        t = createTestStore({
            tables: [products, transactions, orderIndex],
            views: { salesByProduct, totalSales, allOrders },
        });
    });

    describe('insert + view', () => {
        it('inserts a row and materializes in a filtered aggregate view', () => {
            t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });

            const rows = t.view(salesByProduct);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ productSlug: 'keyboard', total: 79, count: 1 });
        });

        it('filtered view excludes non-matching rows', () => {
            t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'restock', timestamp: 1 });

            expect(t.view(salesByProduct)).toHaveLength(0);
        });

        it('global aggregate sums across multiple inserts', () => {
            t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
            t.insert(transactions, { productSlug: 'mouse', userId: 'bob', amount: 29, type: 'sale', timestamp: 2 });

            const rows = t.view(totalSales);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ revenue: 108, count: 2 });
        });

        it('multi-column aggregate deduplicates by composite key', () => {
            t.insert(orderIndex, { orderId: 'ord-1', productSlug: 'keyboard', userId: 'alice', price: 79, createdAt: 1 });
            t.insert(orderIndex, { orderId: 'ord-2', productSlug: 'mouse', userId: 'bob', price: 29, createdAt: 2 });

            const rows = t.view(allOrders);
            expect(rows).toHaveLength(2);
        });

        it('auto-generates PK when not provided', () => {
            t.insert(transactions, { productSlug: 'a', userId: 'u', amount: 1, type: 'sale', timestamp: 1 });
            t.insert(transactions, { productSlug: 'b', userId: 'u', amount: 2, type: 'sale', timestamp: 2 });

            expect(t.view(totalSales)[0]).toMatchObject({ count: 2 });
        });
    });

    describe('delete', () => {
        it('retracts a row and updates the view', () => {
            t.insert(transactions, { id: 100, productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
            expect(t.view(salesByProduct)).toHaveLength(1);

            t.delete(transactions, 100);
            expect(t.view(salesByProduct)).toHaveLength(0);
        });

        it('throws when deleting a nonexistent row', () => {
            expect(() => t.delete(transactions, 999)).toThrow('no row with id=999');
        });
    });

    describe('reset', () => {
        it('clears all state', () => {
            t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
            expect(t.view(salesByProduct)).toHaveLength(1);

            t.reset();
            expect(t.view(salesByProduct)).toHaveLength(0);
        });
    });

    describe('applyHandler', () => {
        it('returns new state and emits', () => {
            const result = t.applyHandler(inventory, 'sell', { stock: 5 }, ['alice', 79, 1000]);
            expect(result.state.stock).toBe(4);
            expect(result.emits).toHaveLength(1);
            expect(result.emits[0].record).toMatchObject({ userId: 'alice', amount: 79, type: 'sale' });
        });

        it('throws EntityError on guard failure', () => {
            expect(() => t.applyHandler(inventory, 'sell', { stock: 0 }, ['alice', 79, 1000]))
                .toThrow('No stock');
        });

        it('handler without emit returns empty emits', () => {
            const result = t.applyHandler(inventory, 'restock', { stock: 5 }, [10]);
            expect(result.state.stock).toBe(15);
            expect(result.emits).toHaveLength(0);
        });
    });

    describe('applyEmits', () => {
        it('resolves $key and inserts into pipeline', () => {
            const result = t.applyHandler(inventory, 'sell', { stock: 5 }, ['alice', 79, 1000]);
            t.applyEmits(result.emits, 'keyboard');

            const rows = t.view(salesByProduct);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ productSlug: 'keyboard', total: 79 });
        });

        it('full entity round-trip: handler → emit → view', () => {
            // Sell two different products
            const sell1 = t.applyHandler(inventory, 'sell', { stock: 10 }, ['alice', 79, 1]);
            t.applyEmits(sell1.emits, 'keyboard');

            const sell2 = t.applyHandler(inventory, 'sell', { stock: 5 }, ['bob', 29, 2]);
            t.applyEmits(sell2.emits, 'mouse');

            // Verify aggregated view
            const sales = t.view(salesByProduct);
            expect(sales).toHaveLength(2);
            expect(sales.find((r) => r.productSlug === 'keyboard')).toMatchObject({ total: 79, count: 1 });
            expect(sales.find((r) => r.productSlug === 'mouse')).toMatchObject({ total: 29, count: 1 });

            // Verify global aggregate
            const totals = t.view(totalSales);
            expect(totals[0]).toMatchObject({ revenue: 108, count: 2 });
        });
    });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @syncengine/test-utils test`

Expected: All tests pass.

- [ ] **Step 3: Commit**

Commit message: `test(test-utils): self-tests for TestStore — insert, delete, view, entity round-trip`

---

### Task 4: Example Tests in Test App

**Files:**
- Modify: `apps/test/package.json` (add @syncengine/test-utils dependency)
- Create: `apps/test/src/__tests__/views.test.ts`
- Create: `apps/test/src/__tests__/entities.test.ts`

- [ ] **Step 1: Add test-utils dependency to test app**

In `apps/test/package.json`, add to dependencies:

```json
"@syncengine/test-utils": "workspace:*"
```

Run: `pnpm install`

- [ ] **Step 2: Create view pipeline test**

Create `apps/test/src/__tests__/views.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createTestStore } from '@syncengine/test-utils';
import {
    transactions, orderIndex,
    salesByProduct, recentActivity, totalSales, allOrders,
} from '../schema';

describe('View Pipelines', () => {
    it('salesByProduct aggregates by product slug', () => {
        const t = createTestStore({
            tables: [transactions],
            views: { salesByProduct },
        });

        t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
        t.insert(transactions, { productSlug: 'keyboard', userId: 'bob', amount: 79, type: 'sale', timestamp: 2 });
        t.insert(transactions, { productSlug: 'mouse', userId: 'alice', amount: 29, type: 'sale', timestamp: 3 });

        const rows = t.view(salesByProduct);
        expect(rows).toHaveLength(2);

        const kb = rows.find((r) => r.productSlug === 'keyboard');
        expect(kb).toMatchObject({ total: 158, count: 2 });

        const ms = rows.find((r) => r.productSlug === 'mouse');
        expect(ms).toMatchObject({ total: 29, count: 1 });
    });

    it('totalSales computes net revenue including refunds', () => {
        const t = createTestStore({
            tables: [transactions],
            views: { totalSales },
        });

        t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: 79, type: 'sale', timestamp: 1 });
        t.insert(transactions, { productSlug: 'keyboard', userId: 'alice', amount: -79, type: 'refund', timestamp: 2 });

        const totals = t.view(totalSales);
        expect(totals[0]).toMatchObject({ revenue: 0, count: 2 });
    });

    it('allOrders deduplicates by composite key', () => {
        const t = createTestStore({
            tables: [orderIndex],
            views: { allOrders },
        });

        t.insert(orderIndex, { orderId: 'ord-1', productSlug: 'keyboard', userId: 'alice', price: 79, createdAt: 1 });
        t.insert(orderIndex, { orderId: 'ord-2', productSlug: 'mouse', userId: 'bob', price: 29, createdAt: 2 });

        expect(t.view(allOrders)).toHaveLength(2);
    });
});
```

- [ ] **Step 3: Create entity handler test**

Create `apps/test/src/__tests__/entities.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createTestStore } from '@syncengine/test-utils';
import { EntityError } from '@syncengine/core';
import { transactions, orderIndex, salesByProduct, allOrders } from '../schema';
import { inventory } from '../entities/inventory.actor';
import { order } from '../entities/order.actor';

describe('Entity Handlers', () => {
    describe('inventory', () => {
        it('sell decrements stock and emits transaction', () => {
            const t = createTestStore({
                tables: [transactions],
                views: { salesByProduct },
            });

            const result = t.applyHandler(inventory, 'sell', { stock: 10, reserved: 1, reservedBy: 'alice', reservedAt: 1 }, ['alice', 'ord-1', 79, 100]);
            expect(result.state.stock).toBe(9);
            expect(result.emits).toHaveLength(1);

            t.applyEmits(result.emits, 'keyboard');
            expect(t.view(salesByProduct)).toHaveLength(1);
            expect(t.view(salesByProduct)[0]).toMatchObject({ productSlug: 'keyboard', total: 79 });
        });

        it('sell throws when not reserved', () => {
            const t2 = createTestStore({ tables: [transactions], views: {} });
            expect(() =>
                t2.applyHandler(inventory, 'sell', { stock: 10, reserved: 0, reservedBy: '', reservedAt: 0 }, ['alice', 'ord-1', 79, 100]),
            ).toThrow('reservation');
        });
    });

    describe('order', () => {
        it('place transitions from draft to placed and emits to orderIndex', () => {
            const t = createTestStore({
                tables: [orderIndex],
                views: { allOrders },
            });

            const result = t.applyHandler(order, 'place', { status: 'draft', productSlug: '', userId: '', price: 0, createdAt: 0 }, ['alice', 'keyboard', 79, 1000]);
            expect(result.state.status).toBe('placed');
            expect(result.emits).toHaveLength(1);

            t.applyEmits(result.emits, 'ord-123');
            const orders = t.view(allOrders);
            expect(orders).toHaveLength(1);
            expect(orders[0]).toMatchObject({ orderId: 'ord-123', productSlug: 'keyboard' });
        });

        it('cancel from placed succeeds', () => {
            const result = t.applyHandler(order, 'cancel', { status: 'placed', productSlug: 'kb', userId: 'a', price: 79, createdAt: 1 }, []);
            expect(result.state.status).toBe('cancelled');
            expect(result.emits).toHaveLength(0);
        });

        it('invalid transition throws EntityError', () => {
            expect(() =>
                t.applyHandler(order, 'deliver', { status: 'placed', productSlug: 'kb', userId: 'a', price: 79, createdAt: 1 }, []),
            ).toThrow(EntityError);
        });
    });
});
```

- [ ] **Step 4: Add vitest to test app if not present**

Check if `apps/test/package.json` has vitest. If not, add to devDependencies:

```json
"vitest": "^1.0.4"
```

And add test script:

```json
"test": "vitest run"
```

Run: `pnpm install`

- [ ] **Step 5: Run all tests**

Run: `pnpm --filter @syncengine/test-utils test && pnpm --filter @syncengine/test-app test`

(Adjust filter name to match apps/test package name.)

Expected: All tests pass.

- [ ] **Step 6: Commit**

Commit message: `test(test-app): example view pipeline and entity handler tests using @syncengine/test-utils`
