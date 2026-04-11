# entityRef + workflow Design

**Date**: 2026-04-13
**Status**: Draft
**Scope**: Typed actor references (`entityRef`) and auto-discovered durable workflows (`workflow`) for multi-actor coordination.

---

## Problem

Multi-actor coordination in syncengine requires raw `fetch()` calls with string-based Restate RPC URLs. The checkout flow in CheckoutTab manually constructs `/__syncengine/rpc/order/{uuid}/place` — no type safety, no compensation, no durability.

## Solution

Two utilities:

1. **`entityRef(ctx, entityDef, key)`** — a typed actor reference that returns a proxy with autocompleted handler methods. Works inside any Restate context (entity handler, workflow, service).

2. **`workflow(name, handler)`** — a thin wrapper around Restate's `workflow()` that follows syncengine's workspace-keyed convention. Auto-discovered from `*.workflow.ts` files.

---

## entityRef

### API

```typescript
import { entityRef } from '@syncengine/server';

// Inside a Restate handler or workflow:
const inv = entityRef(ctx, inventory, 'headphones');

await inv.sell(userId, orderId, price, Date.now());
//       ^^^^ autocompletes from inventory's handler map
//            typed args (minus the state parameter)
```

### Type signature

```typescript
export function entityRef<
    TName extends string,
    TShape extends EntityStateShape,
    THandlers extends EntityHandlerMap<any>,
    TSourceKeys extends string,
>(
    ctx: restate.Context,
    entity: EntityDef<TName, TShape, THandlers, TSourceKeys>,
    key: string,
): EntityRefProxy<THandlers>;
```

Where `EntityRefProxy<THandlers>` maps each handler to an async method with the correct arg types (same pattern as `ActionMap` in entity-client.ts, minus the state parameter):

```typescript
type EntityRefProxy<THandlers> = {
    readonly [K in keyof THandlers]: THandlers[K] extends EntityHandler<any, infer TArgs>
        ? (...args: TArgs) => Promise<void>
        : never;
};
```

### Implementation

```typescript
export function entityRef(ctx, entity, key) {
    // Extract workspace ID from the Restate context key.
    // Convention: all syncengine Restate objects use {workspaceId}/... keys.
    const { workspaceId } = splitObjectKey(ctx.key);
    const fullKey = `${workspaceId}/${key}`;
    const client = ctx.objectClient({ name: `entity_${entity.$name}` }, fullKey);

    return new Proxy({}, {
        get(_, handlerName: string) {
            return (...args: unknown[]) => client[handlerName](args);
        },
    });
}
```

~15 lines. The proxy intercepts property access and forwards to `ctx.objectClient().handlerName(args)`. The Restate SDK's `Client<VirtualObject<D>>` handles durability, retries, and serialization.

### Workspace ID

Extracted from `ctx.key` via `splitObjectKey()` (already exists in entity-runtime.ts). This means `entityRef` only works inside a Restate context where `ctx.key` follows the `{workspaceId}/...` convention — which is true for all syncengine entities and workflows.

---

## workflow

### API

```typescript
// checkout.workflow.ts
import { defineWorkflow, entityRef } from '@syncengine/server';
import { inventory } from './inventory.actor';
import { order } from './order.actor';

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

### Type signature

```typescript
export interface WorkflowDef<TName extends string, TInput> {
    readonly $tag: 'workflow';
    readonly $name: TName;
    readonly $handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>;
}

export function defineWorkflow<const TName extends string, TInput>(
    name: TName,
    handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>,
): WorkflowDef<TName, TInput>;
```

### Implementation

`defineWorkflow` returns a definition object (like `entity()` returns `EntityDef`). The server's binding phase converts it to a Restate workflow:

```typescript
restate.workflow({
    name: `workflow_${def.$name}`,
    handlers: {
        run: async (ctx: restate.WorkflowContext, input: TInput) => {
            return def.$handler(ctx, input);
        },
    },
});
```

The workflow is keyed by `{workspaceId}/{invocationId}` — the workspace ID comes from the client (via header), and the invocation ID is a UUID generated per execution.

---

## Auto-discovery

### File convention

- Entity definitions: `src/**/*.actor.ts` (existing)
- Workflow definitions: `src/**/*.workflow.ts` (new)

### Server binding

The server's startup glob (`SYNCENGINE_APP_DIR/src/**/*.actor.ts`) is extended to also glob `src/**/*.workflow.ts`. Each workflow export is bound to the Restate endpoint alongside entities:

```typescript
// In server startup:
for (const wf of workflows) {
    endpoint.bind(buildWorkflowObject(wf));
}
```

### Hot reload

The existing `watchActorFiles` in `dev.ts` (line 395) watches `src/**/*.actor.ts`. Extend the filter to also match `*.workflow.ts`:

```typescript
if (!filename || !(filename.endsWith('.actor.ts') || filename.endsWith('.workflow.ts'))) return;
```

The reload sequence is identical — tsx restarts, Restate re-discovers.

---

## Client invocation

### RPC routing

The RPC middleware in vite-plugin/actors.ts (and serve.ts in prod) detects a `workflow/` prefix and routes to Restate:

```
Client:  POST /__syncengine/rpc/workflow/{name}/{invocationId}
Server:  POST {restateUrl}/workflow_{name}/{workspaceId}/{invocationId}/run
```

### `runWorkflow()` — typed client helper

The store exposes a `runWorkflow` method that wraps the RPC call with full type inference:

```typescript
interface Store {
    runWorkflow<TName extends string, TInput>(
        workflow: WorkflowDef<TName, TInput>,
        input: TInput,
    ): Promise<void>;
}
```

Implementation: generates a UUID for the invocation, POSTs to `/__syncengine/rpc/workflow/{name}/{uuid}` with the input as JSON body and the workspace header.

### Usage in React

```typescript
// Before (CheckoutTab) — client orchestrates two entities manually:
await actions.sell(userId, orderId, price, Date.now());
const res = await fetch(`/__syncengine/rpc/order/${orderId}/place`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([userId, slug, price, Date.now()]),
});
// If place fails → sell orphaned. If tab closes mid-saga → orphaned.

// After — one typed call, server handles everything durably:
const s = useStore<DB>();
await s.runWorkflow(checkout, { userId, orderId, productSlug: slug, price });
// Typed input, no fetch, no URL construction.
// Server: entityRef calls both actors, compensates on failure, survives crashes.
```

A reactive `useWorkflow(checkout)` hook with status streaming is a natural follow-up but not in scope for this spec.

---

## File plan

### New files

| File | Purpose |
|------|---------|
| `packages/server/src/entity-ref.ts` | `entityRef()` — typed actor reference proxy |
| `packages/server/src/workflow.ts` | `defineWorkflow()` + `buildWorkflowObject()` |
| `packages/server/src/__tests__/entity-ref.test.ts` | Unit tests for entityRef proxy |

### Modified files

| File | Change |
|------|--------|
| `packages/server/src/index.ts` | Export `entityRef`, `defineWorkflow`, `WorkflowDef` |
| `packages/server/src/entity-runtime.ts` | Extract entity object name convention to a shared constant/helper |
| `packages/cli/src/dev.ts` | Extend file watcher to `*.workflow.ts` |
| `packages/vite-plugin/src/actors.ts` | Add workflow RPC route in middleware |
| `packages/server/src/serve.ts` | Add workflow RPC route in production |
| `packages/core/src/index.ts` | Export `EntityHandler` type (needed by EntityRefProxy) |
| `packages/client/src/store.ts` | Add `runWorkflow()` method to Store interface + implementation |

### Demo update

| File | Change |
|------|--------|
| `apps/test/src/workflows/checkout.workflow.ts` | New: typed checkout workflow using entityRef |
| `apps/test/src/tabs/CheckoutTab.tsx` | Replace manual fetch chain with workflow RPC call |

---

## Non-goals

- `useWorkflow()` React hook (follow-up)
- Workflow status streaming to client (follow-up)
- Visual workflow inspector in dev dashboard (follow-up)
- Saga DSL / declarative step chain (rejected — use async/await with entityRef)
