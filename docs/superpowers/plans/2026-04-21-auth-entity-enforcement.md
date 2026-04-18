# Auth — Entity Access Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `Access` DSL and `USER_PLACEHOLDER` from Plan 1 into the entity runtime. Add an `access` block to entity definitions that is evaluated before every handler dispatch. Substitute `$user` in emit records. Produce a typed `AccessDeniedError`. Both client (optimistic) and server (authoritative) paths enforce the same policy.

**Architecture:** `applyHandler` in `@syncengine/core` gains an optional `user` parameter and an `access` lookup. When an entity declares `access: { handlerName: policy, ... }`, `applyHandler` runs the matching policy with an `AccessContext { user, key, state }` before invoking the handler. If the policy rejects, it throws `AccessDeniedError`. The server's `entity-runtime.ts` resolves `$user` in emitted records the same way it resolves `$key`. The client's `entity-client.ts` feeds the current user into `applyHandler` during optimistic execution, so locally-denied actions never reach the wire.

**Tech Stack:** TypeScript, Vitest. No new dependencies. Builds on `@syncengine/core/auth.ts` (Plan 1, already merged).

**Out of scope (later plans):**
- Session-to-user identity resolution on the wire (Plan 3 — connection auth)
- Channel access enforcement (Plan 4)
- `useUser()` client hook (Plan 5)
- Provider adapters (Plan 6)

For Plan 2, the server runtime's "current user" is always `null` unless tests or calling code supply one explicitly. This is the temporary seam that Plan 3 replaces with real identity extraction from the authenticated WebSocket/RPC call.

---

## File Structure

- **Modify:** `packages/core/src/entity.ts` — `EntityDef.$access` field, `entity()` factory accepts `access` config, `applyHandler` evaluates access policy and substitutes `$user` in emits
- **Modify:** `packages/core/src/errors.ts` — `AccessDeniedError` class + code
- **Modify:** `packages/core/src/__tests__/entity.test.ts` — applyHandler access enforcement tests
- **Create:** `packages/core/src/__tests__/entity-access.test.ts` — dedicated access enforcement tests (avoids growing entity.test.ts further)
- **Modify:** `packages/server/src/entity-runtime.ts` — pass `user` to `applyHandler` (stubbed `null` for now), resolve `$user` placeholders in table deltas
- **Modify:** `packages/server/src/__tests__/entity-runtime.test.ts` — test access enforcement at the server seam
- **Modify:** `packages/client/src/entity-client.ts` — supply current user to `applyHandler` optimistic calls, surface `AccessDeniedError` from server responses
- **Modify:** `packages/client/src/__tests__/` — client-side optimistic denial tests

---

## Task 1: Add `AccessDeniedError` to the errors module

A typed error that callers can `instanceof`-check. Separate from existing `EntityError` so the client-side rebase logic can distinguish permission denials from business-logic failures.

**Files:**
- Modify: `packages/core/src/errors.ts`
- Modify: `packages/core/src/__tests__/errors.test.ts`

- [ ] **Step 1: Read the existing errors module to confirm the patterns in use**

Run: `grep -n "class \|export class\|AuthCode\|errors\\." packages/core/src/errors.ts | head -30`

Note: the module defines `errors.handler(...)`, `errors.schema(...)`, `SyncEngineError`, etc. Follow that factory-function pattern rather than exposing a bare class.

- [ ] **Step 2: Write failing tests**

Append to `packages/core/src/__tests__/errors.test.ts`:

```typescript
import { errors, AccessDeniedError, AuthCode } from '../errors';

describe('AccessDeniedError', () => {
    it('is thrown by errors.accessDenied with code + message', () => {
        expect(() => {
            throw errors.accessDenied(AuthCode.ACCESS_DENIED, {
                message: 'handler sell requires role admin',
                context: { entity: 'inventory', handler: 'sell' },
            });
        }).toThrow(AccessDeniedError);
    });

    it('carries the code, entity, and handler on the instance', () => {
        try {
            throw errors.accessDenied(AuthCode.ACCESS_DENIED, {
                message: 'denied',
                context: { entity: 'inventory', handler: 'sell' },
            });
        } catch (err) {
            if (!(err instanceof AccessDeniedError)) throw new Error('wrong type');
            expect(err.code).toBe(AuthCode.ACCESS_DENIED);
            expect(err.context.entity).toBe('inventory');
            expect(err.context.handler).toBe('sell');
        }
    });

    it('serialises to a wire-safe string that includes the code', () => {
        const err = errors.accessDenied(AuthCode.ACCESS_DENIED, {
            message: 'denied',
            context: { entity: 'inventory', handler: 'sell' },
        });
        expect(err.message).toMatch(/ACCESS_DENIED/);
        expect(err.message).toMatch(/denied/);
    });
});
```

- [ ] **Step 3: Run the tests — verify they fail**

Run: `pnpm --filter @syncengine/core test errors -- --run`

Expected: Imports fail — `AccessDeniedError`, `AuthCode`, `errors.accessDenied` don't exist.

- [ ] **Step 4: Implement**

In `packages/core/src/errors.ts`:

1. Add `AuthCode` enum next to the existing code enums (search for `enum HandlerCode` to find placement):

```typescript
export const AuthCode = {
    ACCESS_DENIED: 'ACCESS_DENIED',
} as const;
export type AuthCode = typeof AuthCode[keyof typeof AuthCode];
```

2. Add `AccessDeniedError` class following the shape of existing error classes (e.g. `EntityError`). The class should extend `SyncEngineError` and set the `category` to `'auth'`:

```typescript
export class AccessDeniedError extends SyncEngineError {
    constructor(
        public readonly code: AuthCode,
        args: { message: string; hint?: string; context?: Record<string, unknown> },
    ) {
        super({
            category: 'auth',
            code,
            message: args.message,
            hint: args.hint,
            context: args.context,
        });
        this.name = 'AccessDeniedError';
        Object.setPrototypeOf(this, AccessDeniedError.prototype);
    }
}
```

3. Add `accessDenied` to the `errors` factory object (search for `export const errors = {` to find the place):

```typescript
accessDenied: (code: AuthCode, args: { message: string; hint?: string; context?: Record<string, unknown> }) =>
    new AccessDeniedError(code, args),
```

4. Export from `packages/core/src/index.ts`: search for the existing `export { errors, ... } from './errors';` block and add `AccessDeniedError, AuthCode` to the list.

- [ ] **Step 5: Run the tests — verify they pass**

Run: `pnpm --filter @syncengine/core test errors -- --run`

Expected: All errors-module tests pass (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/__tests__/errors.test.ts packages/core/src/index.ts
git commit -m "feat(core): AccessDeniedError + AuthCode.ACCESS_DENIED"
```

---

## Task 2: Add `access` config to entity definition

Widen the `entity()` factory and `EntityDef` type so handlers can declare access policies. The `'*'` key acts as the default for any handler not explicitly listed. No runtime evaluation yet — just the config plumbing.

**Files:**
- Modify: `packages/core/src/entity.ts` — add `$access` to `EntityDef`, accept `access` in the config
- Create: `packages/core/src/__tests__/entity-access.test.ts` — config-shape tests

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/entity-access.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { entity, integer, text, Access } from '../index';

describe('entity() access config', () => {
    it('accepts an access block alongside handlers', () => {
        const inventory = entity('inventory', {
            state: { stock: integer() },
            access: {
                restock: Access.deny,
                '*': Access.authenticated,
            },
            handlers: {
                restock(state) { return state; },
            },
        });
        expect(inventory.$access).toBeDefined();
        expect(inventory.$access?.restock).toBe(Access.deny);
        expect(inventory.$access?.['*']).toBe(Access.authenticated);
    });

    it('defaults $access to null when omitted', () => {
        const plain = entity('plain', {
            state: { count: integer() },
            handlers: {
                inc(state) { return state; },
            },
        });
        expect(plain.$access).toBeNull();
    });

    it('rejects an access entry that names a non-existent handler', () => {
        expect(() =>
            entity('bad', {
                state: { n: integer() },
                access: {
                    // @ts-expect-error - 'typo' is not in handlers
                    typo: Access.deny,
                },
                handlers: {
                    real(state) { return state; },
                },
            })
        ).toThrow(/access key 'typo' does not match any handler/);
    });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `pnpm --filter @syncengine/core test entity-access -- --run`

Expected: Tests fail — `$access` not a known property, `access` not a known config field.

- [ ] **Step 3: Implement the type and the factory changes in `packages/core/src/entity.ts`**

Import the `AccessPolicy` type at the top of the file alongside existing imports from `./auth`:

```typescript
import type { AccessPolicy } from './auth';
```

Add a type alias near the other internal type definitions (search for `type TransitionMap` and place nearby):

```typescript
/**
 * Maps handler names (and the wildcard `'*'` default) to access policies.
 * `null` when the entity declares no access block — enforcement is a no-op
 * (any caller allowed, matching pre-auth behavior).
 */
export type EntityAccessMap = Readonly<Record<string, AccessPolicy>>;
```

In the `EntityDef` interface, add the `$access` field (keep alphabetical-ish with the other `$` fields):

```typescript
readonly $access: EntityAccessMap | null;
```

In the `entity()` factory's config parameter:

```typescript
readonly access?: EntityAccessMap;
```

After the existing transition validation (search for `const transitions: TransitionMap | null = config.transitions ?? null;` to find the block), add access validation:

```typescript
const access: EntityAccessMap | null = config.access ?? null;
if (access) {
    const handlerNames = new Set(Object.keys(config.handlers));
    for (const key of Object.keys(access)) {
        if (key === '*') continue;
        if (!handlerNames.has(key)) {
            throw errors.schema(SchemaCode.INVALID_ENTITY_ACCESS, {
                message: `defineEntity('${name}'): access key '${key}' does not match any handler.`,
                hint: `Access keys must match handler names or be '*' (default). Handlers: ${[...handlerNames].join(', ')}`,
                context: { entity: name, key },
            });
        }
    }
}
```

Add `INVALID_ENTITY_ACCESS` to the `SchemaCode` enum in `packages/core/src/errors.ts` (same file touched in Task 1, just add a new entry).

Set `$access: access` in the returned `EntityDef` literal (search for `$transitions: transitions,` — add next to it).

- [ ] **Step 4: Run the tests — verify they pass**

Run: `pnpm --filter @syncengine/core test entity-access -- --run`

Expected: All 3 tests pass.

- [ ] **Step 5: Run the full core test suite**

Run: `pnpm --filter @syncengine/core test -- --run`

Expected: 419 + 3 = 422 tests pass. No regression.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/entity.ts packages/core/src/errors.ts packages/core/src/__tests__/entity-access.test.ts
git commit -m "feat(core): entity() accepts access config — validated at define time"
```

---

## Task 3: `applyHandler` evaluates access policies

Extend `applyHandler` with an optional `user` parameter. When called with a user and the entity has an `$access` block, look up the policy for the handler (falling back to `'*'` if present) and evaluate it. Reject with `AccessDeniedError` before the handler runs.

**Files:**
- Modify: `packages/core/src/entity.ts` — `applyHandler` signature + logic
- Modify: `packages/core/src/__tests__/entity-access.test.ts` — evaluation tests

- [ ] **Step 1: Write failing tests**

Append to `packages/core/src/__tests__/entity-access.test.ts`:

```typescript
import { applyHandler, AccessDeniedError, Access, integer, entity } from '../index';

describe('applyHandler access enforcement', () => {
    const inventory = entity('inventory', {
        state: { stock: integer() },
        access: {
            restock: Access.role('admin'),
            sell: Access.authenticated,
            '*': Access.deny,
        },
        handlers: {
            restock(state, amount: number) { return { ...state, stock: state.stock + amount }; },
            sell(state) { return { ...state, stock: state.stock - 1 }; },
            inspect(state) { return state; },
        },
    });

    it('allows a handler when the policy passes', () => {
        const result = applyHandler(
            inventory,
            'restock',
            { stock: 5 },
            [3],
            { user: { id: 'u1', roles: ['admin'] }, key: 'keyboard' },
        );
        expect(result.stock).toBe(8);
    });

    it('throws AccessDeniedError when the policy rejects', () => {
        expect(() =>
            applyHandler(
                inventory,
                'restock',
                { stock: 5 },
                [3],
                { user: { id: 'u1', roles: ['viewer'] }, key: 'keyboard' },
            ),
        ).toThrow(AccessDeniedError);
    });

    it('falls back to the "*" policy when no handler-specific rule exists', () => {
        expect(() =>
            applyHandler(
                inventory,
                'inspect',
                { stock: 5 },
                [],
                { user: { id: 'u1', roles: ['admin'] }, key: 'keyboard' },
            ),
        ).toThrow(AccessDeniedError);
    });

    it('passes the current state to the policy for ownership checks', () => {
        const orders = entity('orders', {
            state: { userId: text(), total: integer() },
            access: {
                cancel: Access.owner(),
            },
            handlers: {
                cancel(state) { return { ...state, total: 0 }; },
            },
        });
        const aliceState = { userId: 'alice', total: 100 };
        expect(() =>
            applyHandler(
                orders,
                'cancel',
                aliceState,
                [],
                { user: { id: 'bob' }, key: 'order-1' },
            ),
        ).toThrow(AccessDeniedError);
        const ok = applyHandler(
            orders,
            'cancel',
            aliceState,
            [],
            { user: { id: 'alice' }, key: 'order-1' },
        );
        expect(ok.total).toBe(0);
    });

    it('skips enforcement entirely when auth context is undefined', () => {
        // Legacy call path — no auth info, no enforcement. Matches pre-Plan-2 behavior.
        const result = applyHandler(inventory, 'restock', { stock: 5 }, [3]);
        expect(result.stock).toBe(8);
    });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `pnpm --filter @syncengine/core test entity-access -- --run`

Expected: Tests fail — `applyHandler` doesn't yet accept a 5th argument.

- [ ] **Step 3: Implement access enforcement in `applyHandler`**

In `packages/core/src/entity.ts`, update the `applyHandler` signature:

```typescript
export function applyHandler(
    entity: AnyEntity,
    handlerName: string,
    currentState: Record<string, unknown> | null,
    args: readonly unknown[],
    auth?: { readonly user: AuthUser | null; readonly key: string },
): Record<string, unknown> {
```

Import `AuthUser` and `AccessContext` at the top of the file:

```typescript
import type { AuthUser, AccessContext, AccessPolicy } from './auth';
```

Add the access check immediately after the handler-not-found guard and before `const base = ...`:

```typescript
// Access enforcement (Plan 2). Only runs when the caller supplied an
// auth context — legacy callers (pure test-store, older entity runtimes
// that don't yet know about users) skip enforcement. Server + client
// entry points always pass auth context post-Plan-2.
if (auth && entity.$access) {
    const policy: AccessPolicy | undefined =
        entity.$access[handlerName] ?? entity.$access['*'];
    if (policy) {
        const ctx: AccessContext = {
            user: auth.user,
            key: auth.key,
            state: currentState ?? entity.$initialState as Record<string, unknown>,
        };
        if (!policy.check(ctx)) {
            throw errors.accessDenied(AuthCode.ACCESS_DENIED, {
                message: `access denied for handler '${handlerName}' on entity '${entity.$name}'`,
                context: {
                    entity: entity.$name,
                    handler: handlerName,
                    userId: auth.user?.id ?? null,
                    key: auth.key,
                },
            });
        }
    }
}
```

Import `AuthCode` from the errors module at the top of `entity.ts`:

```typescript
import { ..., AuthCode } from './errors';
```

(Add to the existing `from './errors'` import.)

- [ ] **Step 4: Run the tests — verify they pass**

Run: `pnpm --filter @syncengine/core test entity-access -- --run`

Expected: All 5 new tests pass.

- [ ] **Step 5: Run the full core test suite**

Run: `pnpm --filter @syncengine/core test -- --run`

Expected: All tests pass. No regression in existing `applyHandler` callers.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/entity.ts packages/core/src/__tests__/entity-access.test.ts
git commit -m "feat(core): applyHandler enforces access policies when auth context present"
```

---

## Task 4: `$user` placeholder substitution in emit records

When a handler returns an `emit({ effects: [insert(table, { userId: '$user', ... })] })` and the server knows the authenticated user, substitute the literal string `'$user'` with the user's id before the row is published — the same pattern already used for `'$key'`.

**Files:**
- Modify: `packages/server/src/entity-runtime.ts` — resolve `$user` alongside `$key` in `publishTableDeltas`

- [ ] **Step 1: Read the existing `$key` resolution to locate the point of change**

Run: `grep -n "\\\$key" packages/server/src/entity-runtime.ts`

Locate the block around lines 116-124 (in the current file) where `$key` is substituted. That's where `$user` substitution goes.

- [ ] **Step 2: Write a failing test**

Append to `packages/server/src/__tests__/entity-runtime.test.ts` (create a new describe block):

```typescript
describe('$user placeholder resolution', () => {
    it('substitutes "$user" in emitted insert records with the authenticated user id', async () => {
        // Build the same mock ctx the existing tests use. Find the helper
        // at the top of entity-runtime.test.ts (searchHelper: `buildMockCtx`
        // or similar — copy its shape).
        const fakeTable = { $name: 'transactions', $columns: {} } as const;
        const emitsFromHandler = [
            { table: fakeTable.$name, record: { userId: '$user', productSlug: '$key', amount: 100 } },
        ];

        const resolved = resolveEmitPlaceholders(emitsFromHandler, {
            entityKey: 'keyboard',
            userId: 'alice',
        });

        expect(resolved[0].record.userId).toBe('alice');
        expect(resolved[0].record.productSlug).toBe('keyboard');
        expect(resolved[0].record.amount).toBe(100);
    });

    it('leaves "$user" unresolved when userId is null', () => {
        const emits = [
            { table: 't', record: { userId: '$user', amount: 5 } },
        ];
        const resolved = resolveEmitPlaceholders(emits, {
            entityKey: 'k',
            userId: null,
        });
        expect(resolved[0].record.userId).toBe('$user');
    });
});
```

Note: the tests call a new exported helper `resolveEmitPlaceholders` — you'll add it in Step 3 by extracting the existing inline substitution into a testable function.

- [ ] **Step 3: Run tests — verify failure**

Run: `pnpm --filter @syncengine/server test entity-runtime -- --run`

Expected: Tests fail — `resolveEmitPlaceholders` not exported.

- [ ] **Step 4: Implement**

In `packages/server/src/entity-runtime.ts`:

1. Extract the existing placeholder substitution (currently lines 116-124) into a named exported helper. Place it near the top of the file or next to `publishTableDeltas`:

```typescript
/**
 * Resolve `'$key'` and `'$user'` placeholders in emitted insert records.
 * `'$key'` always resolves to the entity instance key. `'$user'` resolves
 * to the authenticated user id when available, otherwise remains as the
 * literal string (legacy behavior — the row will still insert).
 */
export function resolveEmitPlaceholders(
    inserts: readonly EmitInsert[],
    ctx: { readonly entityKey: string; readonly userId: string | null },
): readonly EmitInsert[] {
    return inserts.map((ins) => {
        const hasKeyPh = Object.values(ins.record).some((v) => v === '$key');
        const hasUserPh = ctx.userId !== null && Object.values(ins.record).some((v) => v === '$user');
        if (!hasKeyPh && !hasUserPh) return ins;
        const resolved: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(ins.record)) {
            if (v === '$key') resolved[k] = ctx.entityKey;
            else if (v === '$user' && ctx.userId !== null) resolved[k] = ctx.userId;
            else resolved[k] = v;
        }
        return { table: ins.table, record: resolved };
    });
}
```

2. In `runHandler` (around line 113), replace the inline substitution with a call to the helper. The auth context at this point is stubbed `null` (Plan 3 will wire it):

```typescript
const rawEmits = extractEmits(validated);
// ...
const emits = rawEmits
    ? resolveEmitPlaceholders(rawEmits, {
          entityKey,
          userId: null,  // stub — Plan 3 resolves from authenticated connection
      })
    : undefined;
```

- [ ] **Step 5: Run the tests — verify they pass**

Run: `pnpm --filter @syncengine/server test entity-runtime -- --run`

Expected: Previously failing tests pass. Existing tests still pass (the helper is exact-refactor of the inline code).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/entity-runtime.ts packages/server/src/__tests__/entity-runtime.test.ts
git commit -m "feat(server): resolveEmitPlaceholders — substitute '\$user' alongside '\$key'"
```

---

## Task 5: Server runtime passes auth context to applyHandler

The Restate entity-runtime wrapper currently calls `applyHandler(entity, name, state, args)` without auth. Add the auth context, stubbed with `user: null` until Plan 3 wires the real identity. This task produces no visible behavior change alone — it's the plumbing that makes `Access.public` handlers work end-to-end with an auth context, and ensures everything else is correctly rejected.

**Files:**
- Modify: `packages/server/src/entity-runtime.ts` — pass `auth` to `applyHandler`, catch `AccessDeniedError`
- Modify: `packages/server/src/__tests__/entity-runtime.test.ts` — assert denial propagates as TerminalError with ACCESS_DENIED code

- [ ] **Step 1: Write a failing test**

Append to `packages/server/src/__tests__/entity-runtime.test.ts`:

```typescript
describe('access enforcement at the server seam', () => {
    it('rejects handlers guarded by Access.deny with TerminalError ACCESS_DENIED', async () => {
        const guarded = entity('guarded', {
            state: { n: integer() },
            access: { inc: Access.deny },
            handlers: { inc(state) { return { ...state, n: state.n + 1 }; } },
        });
        const mockCtx = buildMockCtx({ entityKey: 'k1', workspaceId: 'ws-1' });
        await expect(
            runHandlerForTest(mockCtx, guarded, 'inc', []),
        ).rejects.toThrow(/ACCESS_DENIED/);
    });
});
```

`runHandlerForTest` is a shim the test file already has (or should expose) around the private `runHandler`. If it doesn't exist, export `runHandler` from `entity-runtime.ts` for test access (or add a test-only named export in a `packages/server/src/test/` directory).

- [ ] **Step 2: Run — verify failure**

Run: `pnpm --filter @syncengine/server test entity-runtime -- --run`

Expected: test fails — the server doesn't yet pass auth context, so `Access.deny` is never consulted.

- [ ] **Step 3: Implement**

In `runHandler` (packages/server/src/entity-runtime.ts), update the `applyHandler` call site:

```typescript
validated = applyHandler(
    entity,
    handlerName,
    merged,
    args,
    { user: null, key: entityKey },  // Plan 3 wires real user
);
```

In the existing catch block, add a branch for `AccessDeniedError`:

```typescript
} catch (err) {
    if (err instanceof AccessDeniedError) {
        throw new restate.TerminalError(`[${err.code}] ${err.message}`);
    }
    if (err instanceof SyncEngineError) { /* existing */ }
    // ...
```

Import `AccessDeniedError` at the top of the file:

```typescript
import { AccessDeniedError } from '@syncengine/core';
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm --filter @syncengine/server test -- --run`

Expected: All 122+ tests pass including the new denial test.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/entity-runtime.ts packages/server/src/__tests__/entity-runtime.test.ts
git commit -m "feat(server): entity runtime threads auth context to applyHandler"
```

---

## Task 6: Client `applyHandler` calls supply the current user

The client's optimistic path currently calls `applyHandler(entity, handlerName, state, args)`. Extend it to pass `{ user, key }`. For now, the user is sourced from a lightweight `getCurrentUser()` getter with a default of `null` — Plan 5 replaces this with real `useUser()` integration.

**Files:**
- Modify: `packages/client/src/entity-client.ts` — accept a `getUser` function, thread it into applyHandler calls
- Modify: `packages/client/src/store.ts` — plumb `getUser` through (default `() => null`)
- Modify: `packages/client/src/__tests__/` — client-side denial tests

- [ ] **Step 1: Locate the client-side `applyHandler` call sites**

Run: `grep -n "applyHandler" packages/client/src/`

You'll find calls in `entity-client.ts` (both the `actions.*` proxy and the `rebase` function).

- [ ] **Step 2: Write failing tests**

Add to the relevant client test file (look for the existing entity-client test — if one doesn't exist, create `packages/client/src/__tests__/entity-client-access.test.ts`):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Access, entity, integer, AccessDeniedError } from '@syncengine/core';
import { createOptimisticRunner } from '../entity-client';  // may need to be extracted

describe('client optimistic access enforcement', () => {
    const guarded = entity('guarded', {
        state: { n: integer() },
        access: { inc: Access.role('admin') },
        handlers: { inc(state) { return { ...state, n: state.n + 1 }; } },
    });

    it('rejects a handler locally when the user lacks the role', () => {
        const runner = createOptimisticRunner({
            entityDef: guarded,
            getUser: () => ({ id: 'u1', roles: ['viewer'] }),
        });
        expect(() => runner.run('inc', { n: 0 }, [], 'k1')).toThrow(AccessDeniedError);
    });

    it('allows a handler locally when the user has the role', () => {
        const runner = createOptimisticRunner({
            entityDef: guarded,
            getUser: () => ({ id: 'u1', roles: ['admin'] }),
        });
        const next = runner.run('inc', { n: 0 }, [], 'k1');
        expect(next.n).toBe(1);
    });
});
```

- [ ] **Step 3: Run — verify failure**

Run: `pnpm --filter @syncengine/client test -- --run entity-client-access`

Expected: Import fails — `createOptimisticRunner` not yet extracted.

- [ ] **Step 4: Implement**

Extract a small runner helper from `entity-client.ts` that takes a `getUser` function and wraps `applyHandler` with the auth context. Thread it through the existing `actions.*` proxy and `rebase`. At the top level (the `store()` factory in `store.ts`), add a `getUser` option:

```typescript
export function store(config: { ..., getUser?: () => AuthUser | null }) {
    const getUser = config.getUser ?? (() => null);
    // ... thread getUser to useEntity
}
```

In `useEntity`:

```typescript
actions.inc = (...args) => {
    const user = getUser();
    const next = applyHandler(entityDef, 'inc', confirmed, args, { user, key });
    // ... existing optimistic queue logic
};
```

The `rebase` path: when the server rejects with `[ACCESS_DENIED]`, drop the pending action and set `error` to an `AccessDeniedError` instance. Add an error-parsing helper:

```typescript
function parseAccessDeniedFromTerminal(message: string): AccessDeniedError | null {
    const m = message.match(/^\[ACCESS_DENIED\]\s*(.+)$/);
    if (!m) return null;
    return errors.accessDenied(AuthCode.ACCESS_DENIED, { message: m[1] });
}
```

- [ ] **Step 5: Run the tests — verify they pass**

Run: `pnpm --filter @syncengine/client test -- --run`

Expected: New tests pass. Existing tests continue to pass (default `getUser` returning `null` keeps pre-auth behavior for entities without an `$access` block).

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/entity-client.ts packages/client/src/store.ts packages/client/src/__tests__/
git commit -m "feat(client): thread getUser() through optimistic applyHandler + rebase"
```

---

## Task 7: End-to-end smoke test

Wire a small `apps/test` entity with an `access` block and assert round-trip behavior: allowed handler returns confirmed state, denied handler leaves state unchanged and surfaces `AccessDeniedError`.

**Files:**
- Modify: `apps/test/src/entities/` — add or adapt one entity with an `access` block
- Modify: `apps/test/src/__tests__/` — integration test

*If the test harness doesn't support injecting a user yet, stub it by calling `applyHandler` directly via the test store rather than through Restate — the wiring in Plans 3-5 will upgrade to full e2e.*

- [ ] **Step 1: Write the smoke test**

Create or modify a test that:
1. Defines an entity with `access: { adminOnly: Access.role('admin') }`
2. Calls the handler with a user lacking the role → expect `AccessDeniedError`
3. Calls with an admin user → expect handler to run and state to change

- [ ] **Step 2: Run — expect pass (no new implementation)**

Run: `pnpm --filter @syncengine/test test -- --run`

Expected: Pass on first run (relies only on Plan 2 changes).

- [ ] **Step 3: Commit**

```bash
git add apps/test/
git commit -m "test(e2e): entity access enforcement smoke test"
```

---

## Task 8: Full workspace verification

- [ ] **Step 1: Build**

Run: `pnpm -w build`

Expected: Clean build.

- [ ] **Step 2: Core tests**

Run: `pnpm --filter @syncengine/core test -- --run`

Expected: All pass.

- [ ] **Step 3: Server tests**

Run: `pnpm --filter @syncengine/server test -- --run`

Expected: All pass.

- [ ] **Step 4: Client tests**

Run: `pnpm --filter @syncengine/client test -- --run`

Expected: All pass except the pre-existing `store.test.ts` failure about channel validation (document this as unrelated).

- [ ] **Step 5: Type-check**

Run: `pnpm -r --if-present typecheck`

Expected: Clean across all packages.

---

## Definition of Done

- `AccessDeniedError` + `AuthCode.ACCESS_DENIED` exist and are exported.
- Entity `access` block accepted by `entity()` factory, validated at define time, available as `entity.$access`.
- `applyHandler(entity, handler, state, args, { user, key })` enforces policies and throws `AccessDeniedError` on rejection.
- Legacy `applyHandler` calls without auth argument continue to work (no enforcement, matching pre-Plan-2 behavior).
- `$user` placeholder substituted in emitted table rows alongside `$key`.
- Server entity-runtime threads a stubbed `user: null` through `applyHandler` and propagates `AccessDeniedError` as Restate `TerminalError` with the `ACCESS_DENIED` code prefix.
- Client optimistic path calls `applyHandler` with the current user from a `getUser` getter (default `null`).
- Client rebase path parses `ACCESS_DENIED` from server terminal errors and surfaces `AccessDeniedError` via the entity hook's `error` field.
- Full workspace build and core+server+client suites pass.

## What This Plan Does NOT Do

- **No real session → user resolution on the wire.** Server stubs `user: null`; client stubs `getUser() → null`. Plan 3 (connection auth) wires the real identity extraction from authenticated WebSocket/RPC.
- **No channel access.** Plan 4.
- **No `useUser()` hook.** Plan 5 adds the React hook and token lifecycle.
- **No provider adapters.** Plan 6.

## Subsequent Plans

| # | Plan | What it adds |
|---|------|-------------|
| 3 | Workspace + Connection Auth | AuthProvider port, WebSocket handshake, workspace membership check, replaces the stubs in this plan |
| 4 | Channel Access | Subscription-time access predicate on channels |
| 5 | Client SDK | `useUser()` hook, token lifecycle, connect getUser getter to reactive auth state |
| 6 | Provider Adapters | `@hexo/auth-custom` (JWT), Clerk adapter pattern |
