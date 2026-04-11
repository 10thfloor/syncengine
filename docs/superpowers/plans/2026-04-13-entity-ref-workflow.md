# entityRef + workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typed actor references (`entityRef`) and auto-discovered durable workflows (`defineWorkflow`) so multi-actor coordination is type-safe, compensable, and durable.

**Architecture:** `entityRef` is a Proxy that wraps Restate's `ctx.objectClient()` with types inferred from `EntityDef`. `defineWorkflow` wraps Restate's `workflow()` with syncengine's workspace-key convention. Workflows are auto-discovered from `*.workflow.ts` files alongside actors. The client calls workflows via `store.runWorkflow()` which POSTs through the existing RPC proxy.

**Tech Stack:** TypeScript, `@restatedev/restate-sdk` (already installed), Restate virtual objects + workflows.

**Spec:** `docs/superpowers/specs/2026-04-13-entity-ref-workflow-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `packages/server/src/entity-ref.ts` | `entityRef()` proxy + `EntityRefProxy` type |
| `packages/server/src/workflow.ts` | `defineWorkflow()`, `WorkflowDef`, `buildWorkflowObject()`, `isWorkflow()` |
| `packages/server/src/__tests__/entity-ref.test.ts` | Unit tests for entityRef proxy behavior |
| `apps/test/src/workflows/checkout.workflow.ts` | Demo checkout workflow using entityRef |

### Modified files

| File | What changes |
|------|-------------|
| `packages/core/src/index.ts` | Export `EntityHandler` type |
| `packages/server/src/index.ts` | Load `*.workflow.ts` files, bind workflows to Restate endpoint |
| `packages/server/src/entity-runtime.ts` | Export `ENTITY_OBJECT_PREFIX` constant |
| `packages/vite-plugin/src/actors.ts` | Add workflow RPC route (`/__syncengine/rpc/workflow/...`) |
| `packages/server/src/serve.ts` | Add workflow RPC route in production |
| `packages/cli/src/dev.ts` | Extend file watcher to `*.workflow.ts` |
| `packages/client/src/store.ts` | Add `runWorkflow()` to Store interface + implementation |
| `apps/test/src/tabs/CheckoutTab.tsx` | Replace manual fetch chain with `runWorkflow(checkout, ...)` |

---

### Task 1: entityRef — typed actor reference

**Files:**
- Create: `packages/server/src/entity-ref.ts`
- Create: `packages/server/src/__tests__/entity-ref.test.ts`
- Modify: `packages/server/src/entity-runtime.ts` — extract entity name prefix constant
- Modify: `packages/core/src/index.ts` — export `EntityHandler` type

- [ ] **Step 1: Export EntityHandler from core**

In `packages/core/src/index.ts`, find the entity DSL exports section and add `EntityHandler`:

```typescript
// In the entity DSL exports block, add:
export type { EntityHandler } from './entity.js';
```

- [ ] **Step 2: Extract entity name prefix in entity-runtime.ts**

In `packages/server/src/entity-runtime.ts`, the string `entity_` is used as the Restate object name prefix. Extract it as a constant so `entityRef` can import it:

Find (around line 275):
```typescript
return restate.object({
    name: `entity_${entity.$name}`,
```

Add before that function (around line 269):
```typescript
/** Restate virtual object name prefix for entities. */
export const ENTITY_OBJECT_PREFIX = 'entity_';
```

And update the usage:
```typescript
return restate.object({
    name: `${ENTITY_OBJECT_PREFIX}${entity.$name}`,
```

- [ ] **Step 3: Write the failing tests**

```typescript
// packages/server/src/__tests__/entity-ref.test.ts
import { describe, it, expect, vi } from 'vitest';
import { entityRef } from '../entity-ref.js';
import { entity, integer, text } from '@syncengine/core';

// Minimal test entity
const counter = entity('counter', {
    state: { value: integer() },
    handlers: {
        increment(state) { return { ...state, value: state.value + 1 }; },
        add(state, amount: number) { return { ...state, value: state.value + amount }; },
    },
});

function mockCtx(key: string) {
    const callLog: Array<{ method: string; args: unknown[] }> = [];
    const clientProxy = new Proxy({}, {
        get(_, method: string) {
            return (...args: unknown[]) => {
                callLog.push({ method, args });
                return Promise.resolve({ state: {} });
            };
        },
    });
    return {
        ctx: {
            key,
            objectClient: vi.fn().mockReturnValue(clientProxy),
        },
        callLog,
    };
}

describe('entityRef', () => {
    it('creates a proxy with handler methods', () => {
        const { ctx } = mockCtx('ws123/mykey');
        const ref = entityRef(ctx as any, counter, 'mykey');
        expect(typeof ref.increment).toBe('function');
        expect(typeof ref.add).toBe('function');
    });

    it('calls ctx.objectClient with correct entity name and full key', async () => {
        const { ctx } = mockCtx('ws123/mykey');
        const ref = entityRef(ctx as any, counter, 'mykey');
        await ref.increment();
        expect(ctx.objectClient).toHaveBeenCalledWith(
            { name: 'entity_counter' },
            'ws123/mykey',
        );
    });

    it('forwards handler args', async () => {
        const { ctx, callLog } = mockCtx('ws123/mykey');
        const ref = entityRef(ctx as any, counter, 'mykey');
        await ref.add(42);
        expect(callLog).toHaveLength(1);
        expect(callLog[0].method).toBe('add');
        expect(callLog[0].args).toEqual([[42]]);
    });

    it('extracts workspace ID from ctx.key', async () => {
        const { ctx } = mockCtx('workspace-abc/entity-key');
        const ref = entityRef(ctx as any, counter, 'entity-key');
        await ref.increment();
        expect(ctx.objectClient).toHaveBeenCalledWith(
            { name: 'entity_counter' },
            'workspace-abc/entity-key',
        );
    });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/__tests__/entity-ref.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement entityRef**

```typescript
// packages/server/src/entity-ref.ts
import type * as restate from '@restatedev/restate-sdk';
import type {
    EntityDef,
    EntityStateShape,
    EntityHandlerMap,
    EntityHandler,
} from '@syncengine/core';
import { splitObjectKey } from './entity-runtime.js';
import { ENTITY_OBJECT_PREFIX } from './entity-runtime.js';

/**
 * Typed actor reference — maps entity handler signatures to async RPC
 * methods via Restate's objectClient. The first handler parameter (state)
 * is supplied by the framework; the caller passes only trailing args.
 */
export type EntityRefProxy<THandlers> = {
    readonly [K in keyof THandlers]: THandlers[K] extends EntityHandler<any, infer TArgs>
        ? (...args: TArgs) => Promise<void>
        : never;
};

/**
 * Create a typed actor reference for calling entity handlers from
 * server-side Restate contexts (other entity handlers or workflows).
 *
 * ```ts
 * const inv = entityRef(ctx, inventory, 'headphones');
 * await inv.sell(userId, orderId, price, Date.now());
 * ```
 *
 * The workspace ID is extracted from `ctx.key` (convention:
 * `{workspaceId}/...` for all syncengine Restate objects).
 */
export function entityRef<
    TName extends string,
    TShape extends EntityStateShape,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    THandlers extends EntityHandlerMap<any>,
    TSourceKeys extends string,
>(
    ctx: { key: string; objectClient(opts: { name: string }, key: string): any },
    entityDef: EntityDef<TName, TShape, THandlers, TSourceKeys>,
    key: string,
): EntityRefProxy<THandlers> {
    const { workspaceId } = splitObjectKey(ctx.key);
    const fullKey = `${workspaceId}/${key}`;
    const client = ctx.objectClient(
        { name: `${ENTITY_OBJECT_PREFIX}${entityDef.$name}` },
        fullKey,
    );

    return new Proxy({} as EntityRefProxy<THandlers>, {
        get(_, handlerName: string) {
            return (...args: unknown[]) => client[handlerName](args);
        },
    });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/__tests__/entity-ref.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/server/src/entity-ref.ts packages/server/src/entity-runtime.ts packages/server/src/__tests__/entity-ref.test.ts
git commit -m "feat(server): add entityRef — typed actor reference for server-side RPC"
```

---

### Task 2: defineWorkflow + buildWorkflowObject

**Files:**
- Create: `packages/server/src/workflow.ts`

- [ ] **Step 1: Create workflow.ts**

```typescript
// packages/server/src/workflow.ts
import * as restate from '@restatedev/restate-sdk';

/** The output of `defineWorkflow(...)`. Carries the typed name and handler. */
export interface WorkflowDef<TName extends string = string, TInput = unknown> {
    readonly $tag: 'workflow';
    readonly $name: TName;
    readonly $handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>;
}

/** Runtime type guard for WorkflowDef. */
export function isWorkflow(value: unknown): value is WorkflowDef {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>).$tag === 'workflow'
    );
}

/** Restate workflow name prefix (mirrors ENTITY_OBJECT_PREFIX for entities). */
export const WORKFLOW_OBJECT_PREFIX = 'workflow_';

/**
 * Define a durable workflow that coordinates entity handler calls.
 *
 * ```ts
 * export const checkout = defineWorkflow('checkout', async (ctx, input: CheckoutInput) => {
 *     const inv = entityRef(ctx, inventory, input.productSlug);
 *     await inv.sell(input.userId, input.orderId, input.price, Date.now());
 * });
 * ```
 *
 * The workflow is auto-discovered from `*.workflow.ts` files and registered
 * with Restate. It runs as a durable workflow keyed by `{workspaceId}/{invocationId}`.
 */
export function defineWorkflow<const TName extends string, TInput>(
    name: TName,
    handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
): WorkflowDef<TName, TInput> {
    if (!name || typeof name !== 'string') {
        throw new Error('defineWorkflow: name must be a non-empty string.');
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(
            `defineWorkflow('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/.`,
        );
    }
    return {
        $tag: 'workflow',
        $name: name,
        $handler: handler,
    };
}

/** Convert a WorkflowDef into a Restate workflow object for endpoint binding. */
export function buildWorkflowObject(def: WorkflowDef): ReturnType<typeof restate.workflow> {
    return restate.workflow({
        name: `${WORKFLOW_OBJECT_PREFIX}${def.$name}`,
        handlers: {
            run: async (ctx: restate.WorkflowContext, input: unknown) => {
                await def.$handler(ctx, input);
            },
        },
    });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/server && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/workflow.ts
git commit -m "feat(server): add defineWorkflow + buildWorkflowObject"
```

---

### Task 3: Auto-discovery — load and bind workflows

**Files:**
- Modify: `packages/server/src/index.ts` — load `*.workflow.ts`, bind to Restate
- Modify: `packages/cli/src/dev.ts` — extend file watcher

- [ ] **Step 1: Update server index.ts to load and bind workflows**

In `packages/server/src/index.ts`:

Add import at top:
```typescript
import { isWorkflow, buildWorkflowObject, type WorkflowDef } from './workflow.js';
```

Update `walkActorFiles` to also find `.workflow.ts` files. Rename it to `walkSourceFiles` and update the filter:

```typescript
} else if (st.isFile() && (name.endsWith('.actor.ts') || name.endsWith('.workflow.ts'))) {
```

Add a `loadWorkflows` function (mirrors `loadEntities`):

```typescript
export async function loadWorkflows(appDir: string): Promise<WorkflowDef[]> {
    const srcDir = resolve(appDir, 'src');
    const files = walkSourceFiles(srcDir).filter(f => f.endsWith('.workflow.ts'));
    const workflows: WorkflowDef[] = [];
    for (const file of files) {
        try {
            const mod = (await import(file)) as Record<string, unknown>;
            for (const value of Object.values(mod)) {
                if (isWorkflow(value)) workflows.push(value);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[workspace-service] failed to load workflow file ${file}: ${msg}`);
        }
    }
    return workflows;
}
```

Update `startRestateEndpoint` to accept and bind workflows:

```typescript
export async function startRestateEndpoint(
    entities: AnyEntity[],
    workflows: WorkflowDef[],
    port: number,
): Promise<void> {
    const endpoint = restate.endpoint().bind(workspace);
    const bound = bindEntities(endpoint, entities);
    for (const wf of workflows) {
        bound.bind(buildWorkflowObject(wf));
    }
    await bound.listen(port);

    const parts = [];
    if (entities.length > 0) parts.push(`entities: ${entities.map(e => e.$name).join(', ')}`);
    if (workflows.length > 0) parts.push(`workflows: ${workflows.map(w => w.$name).join(', ')}`);
    console.log(`[workspace-service] listening on :${port}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`);
}
```

Update the direct-execution block at the bottom:

```typescript
if (appDir) {
    const PORT = parseInt(process.env.PORT ?? '9080', 10);
    const entities = await loadEntities(appDir);
    const workflows = await loadWorkflows(appDir);
    await startRestateEndpoint(entities, workflows, PORT);
}
```

- [ ] **Step 2: Extend file watcher in dev.ts**

In `packages/cli/src/dev.ts`, find the `watchActorFiles` function (the filter check inside the callback). Change:

```typescript
if (!filename || !String(filename).endsWith('.actor.ts')) return;
```

to:

```typescript
const fname = String(filename);
if (!filename || !(fname.endsWith('.actor.ts') || fname.endsWith('.workflow.ts'))) return;
```

- [ ] **Step 3: Export from server package**

In `packages/server/src/index.ts`, add at the top alongside existing exports:

```typescript
export { entityRef, type EntityRefProxy } from './entity-ref.js';
export { defineWorkflow, isWorkflow, type WorkflowDef } from './workflow.js';
```

Wait — the server package doesn't use a barrel export pattern (it has `startRestateEndpoint` + `loadEntities` as the main exports). Add the new exports at the bottom of the file:

```typescript
// Re-export workflow + entityRef primitives for user code
export { entityRef, type EntityRefProxy } from './entity-ref.js';
export { defineWorkflow, isWorkflow, type WorkflowDef } from './workflow.js';
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/index.ts packages/server/src/workflow.ts packages/cli/src/dev.ts
git commit -m "feat(server): auto-discover and bind *.workflow.ts files"
```

---

### Task 4: Workflow RPC routing (dev + prod)

**Files:**
- Modify: `packages/vite-plugin/src/actors.ts` — add workflow route
- Modify: `packages/server/src/serve.ts` — add workflow route

- [ ] **Step 1: Add workflow route to vite-plugin RPC middleware**

In `packages/vite-plugin/src/actors.ts`, find the `buildRpcMiddleware` function. At the top of the middleware handler (right after the `if (!req.url.startsWith('/__syncengine/rpc/'))` check), add a workflow route branch:

```typescript
// Workflow RPC: /__syncengine/rpc/workflow/<name>/<invocationId>
if (req.url.startsWith('/__syncengine/rpc/workflow/')) {
    const wfParts = req.url.slice('/__syncengine/rpc/workflow/'.length).split('?')[0]!.split('/');
    if (wfParts.length !== 2) {
        res.statusCode = 400;
        res.end('Expected /__syncengine/rpc/workflow/<name>/<invocationId>');
        return;
    }
    const [wfNameRaw, invocationIdRaw] = wfParts as [string, string];
    let wfName: string;
    let invocationId: string;
    try {
        wfName = decodeURIComponent(wfNameRaw);
        invocationId = decodeURIComponent(invocationIdRaw);
    } catch {
        res.statusCode = 400;
        res.end('Malformed URL-encoded path component');
        return;
    }
    if (!NAME_REGEX.test(wfName)) {
        res.statusCode = 400;
        res.end('Invalid workflow name');
        return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8') || '{}';

    // Resolve workspace ID (same logic as entity RPC)
    const headerWs = req.headers['x-syncengine-workspace'];
    const headerWsValue = Array.isArray(headerWs) ? headerWs[0] : headerWs;
    let workspaceId: string;
    if (typeof headerWsValue === 'string' && headerWsValue.length > 0) {
        if (!WORKSPACE_HEADER_REGEX.test(headerWsValue)) {
            res.statusCode = 400;
            res.end('Invalid x-syncengine-workspace header');
            return;
        }
        workspaceId = headerWsValue;
    } else {
        workspaceId = workspaceIdFallbackFn();
    }

    const restateUrl = restateUrlFn().replace(/\/+$/, '');
    const targetUrl =
        `${restateUrl}/workflow_${wfName}` +
        `/${encodeURIComponent(`${workspaceId}/${invocationId}`)}/run`;

    try {
        const upstream = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
        });
        const text = await upstream.text();
        res.statusCode = upstream.status;
        res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
        res.end(text);
    } catch (err) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
            message: `[syncengine] failed to reach Restate at ${targetUrl}: ${(err as Error).message}`,
        }));
    }
    return;
}
```

This block must come BEFORE the existing entity RPC parsing (which checks `pathParts.length !== 3` and would reject workflow URLs).

- [ ] **Step 2: Add workflow route to production serve.ts**

In `packages/server/src/serve.ts`, find the `handleRpc` function. Add a workflow branch at the top of the function, before the entity path parsing:

```typescript
// Workflow RPC: /__syncengine/rpc/workflow/<name>/<invocationId>
if (pathname.startsWith('/__syncengine/rpc/workflow/')) {
    const wfParts = pathname.slice('/__syncengine/rpc/workflow/'.length).split('/');
    if (wfParts.length !== 2) {
        res.writeHead(400).end('Expected /__syncengine/rpc/workflow/<name>/<invocationId>');
        return;
    }
    const [wfNameRaw, invocationIdRaw] = wfParts as [string, string];
    let wfName: string;
    let invocationId: string;
    try {
        wfName = decodeURIComponent(wfNameRaw);
        invocationId = decodeURIComponent(invocationIdRaw);
    } catch {
        res.writeHead(400).end('Malformed URL-encoded path component');
        return;
    }
    if (!NAME_REGEX.test(wfName)) {
        res.writeHead(400).end('Invalid workflow name');
        return;
    }

    const body = await readBody(req);

    const headerWs = req.headers['x-syncengine-workspace'];
    const headerWsValue = Array.isArray(headerWs) ? headerWs[0] : headerWs;
    let workspaceId: string;
    if (typeof headerWsValue === 'string' && headerWsValue.length > 0) {
        if (!WORKSPACE_HEADER_REGEX.test(headerWsValue)) {
            res.writeHead(400).end('Invalid x-syncengine-workspace header');
            return;
        }
        workspaceId = headerWsValue;
    } else {
        workspaceId = hashWorkspaceId('default');
    }

    const targetUrl =
        `${restateIngressUrl.replace(/\/+$/, '')}/workflow_${wfName}` +
        `/${encodeURIComponent(`${workspaceId}/${invocationId}`)}/run`;

    try {
        const upstream = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') || 'application/json',
        }).end(text);
    } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' }).end(
            JSON.stringify({
                message: `[syncengine] failed to reach Restate at ${targetUrl}: ${(err as Error).message}`,
            }),
        );
    }
    return;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/vite-plugin/src/actors.ts packages/server/src/serve.ts
git commit -m "feat(rpc): add workflow routing to dev and production RPC middleware"
```

---

### Task 5: Client — `runWorkflow()` on Store

**Files:**
- Modify: `packages/client/src/store.ts` — add `runWorkflow` to Store interface + implementation

- [ ] **Step 1: Add WorkflowDef type import**

The `WorkflowDef` type is defined in `@syncengine/server` but the client package shouldn't depend on the server package. Define a minimal interface in store.ts:

```typescript
/** Minimal shape of a WorkflowDef — avoids importing @syncengine/server in the client. */
interface AnyWorkflowDef {
    readonly $tag: 'workflow';
    readonly $name: string;
}
```

- [ ] **Step 2: Add runWorkflow to Store interface**

In the `Store` interface, add after `useTopic`:

```typescript
    /** Execute a durable workflow via the RPC proxy. Returns when the
     *  workflow completes (or throws on failure). */
    runWorkflow<TInput>(
        workflow: AnyWorkflowDef & { readonly $handler: (ctx: any, input: TInput) => Promise<void> },
        input: TInput,
    ): Promise<void>;
```

- [ ] **Step 3: Implement runWorkflow in the store factory**

In the returned store object (around line 924), add `runWorkflow`:

```typescript
    async runWorkflow(workflow, input) {
        const invocationId = crypto.randomUUID();
        const url = `/__syncengine/rpc/workflow/${workflow.$name}/${invocationId}`;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (runtimeWorkspaceId) {
            headers['x-syncengine-workspace'] = runtimeWorkspaceId;
        }
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(input),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '<no body>');
            throw new Error(`workflow '${workflow.$name}' failed: ${res.status} ${text}`);
        }
    },
```

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/store.ts
git commit -m "feat(client): add runWorkflow() to Store for typed workflow invocation"
```

---

### Task 6: Demo — checkout workflow + CheckoutTab update

**Files:**
- Create: `apps/test/src/workflows/checkout.workflow.ts`
- Modify: `apps/test/src/tabs/CheckoutTab.tsx`

- [ ] **Step 1: Create checkout.workflow.ts**

```typescript
// apps/test/src/workflows/checkout.workflow.ts
import { defineWorkflow, entityRef } from '@syncengine/server';
import { inventory } from '../entities/inventory.actor';
import { order } from '../entities/order.actor';

interface CheckoutInput {
    userId: string;
    orderId: string;
    productSlug: string;
    price: number;
}

export const checkout = defineWorkflow('checkout', async (ctx, input: CheckoutInput) => {
    const inv = entityRef(ctx, inventory, input.productSlug);
    const ord = entityRef(ctx, order, input.orderId);

    // Durable step 1: sell (consumes reservation, emits transaction)
    await inv.sell(input.userId, input.orderId, input.price, Date.now());

    // Durable step 2: place order (with compensation on failure)
    try {
        await ord.place(input.userId, input.productSlug, input.price, Date.now());
    } catch {
        // Compensation: release the reservation
        await inv.releaseReservation(input.userId);
        throw;
    }
});
```

- [ ] **Step 2: Update CheckoutTab to use runWorkflow**

In `apps/test/src/tabs/CheckoutTab.tsx`, import the checkout workflow:

```typescript
import { checkout } from '../workflows/checkout.workflow';
```

Find the `handleBuy` callback (around line 106). Replace the manual saga with:

```typescript
const handleBuy = useCallback(async () => {
    setError(null);
    setBuying(true);
    const orderId = crypto.randomUUID();
    try {
        await s.runWorkflow(checkout, { userId, orderId, productSlug: slug, price });
        setReservedAt(null);
    } catch (e: unknown) {
        setError((e as Error).message);
    } finally {
        setBuying(false);
    }
}, [s, userId, price, slug]);
```

This removes the manual `actions.sell()` + `fetch()` chain and replaces it with a single typed call.

Note: `s` is the store instance from `useStore<DB>()`. The `handleBuy` closure needs `s` — add it to the component scope if not already available. Check the current code — `s` is declared on line 44. The `actions` variable can remain for the reserve/release buttons but is no longer needed in `handleBuy`.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd apps/test && npx tsc --noEmit 2>&1 | grep -v vite-plugin`

- [ ] **Step 4: Commit**

```bash
git add apps/test/src/workflows/checkout.workflow.ts apps/test/src/tabs/CheckoutTab.tsx
git commit -m "feat(demo): replace manual checkout saga with typed workflow"
```

---

### Task 7: Smoke test

- [ ] **Step 1: Restart dev stack**

Run: `cd apps/test && pnpm syncengine dev`

Verify:
- Gateway on `:9333`
- Console shows workflows loaded: `workflows: checkout`

- [ ] **Step 2: Test the checkout workflow**

1. Open `http://localhost:5173/?user=alice`
2. Go to Checkout tab
3. Reserve a product
4. Click Buy
5. Verify the order appears in the Orders tab
6. Check that the transaction appears in the Activity tab

- [ ] **Step 3: Test compensation**

This requires the `order.place` handler to fail. Temporarily add a guard that rejects orders for a specific product to test that `inventory.releaseReservation` runs as compensation.

- [ ] **Step 4: Verify entity get CLI shows workflow effects**

```bash
pnpm syncengine entity -- get inventory headphones
# Should show decremented stock after purchase
```

---

## Summary

| Task | Component | Files | Steps |
|------|-----------|-------|-------|
| 1 | entityRef (typed actor reference) | 4 | 7 |
| 2 | defineWorkflow + buildWorkflowObject | 1 | 3 |
| 3 | Auto-discovery + binding | 3 | 4 |
| 4 | Workflow RPC routing (dev + prod) | 2 | 3 |
| 5 | Client runWorkflow() | 1 | 4 |
| 6 | Demo checkout workflow | 2 | 4 |
| 7 | Smoke test | 0 | 4 |

**Total: 7 tasks, ~29 steps**

Tasks 1-2 are independent. Task 3 depends on 2. Task 4 is independent. Task 5 is independent. Task 6 depends on 1-5. Task 7 depends on all.
