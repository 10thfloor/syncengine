# Auth — Workspace + Connection Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the `user: null` stubs from Plan 2 with verified identity extracted from the `Authorization: Bearer …` token on every RPC call. Ship the `AuthProvider` port, a pluggable adapter layer (`custom()` verifier + an `unverified()` dev-only adapter), and a workspace-membership lookup that populates per-workspace roles on the verified user. Configure via `syncengine.config.ts`.

**Architecture:** A new `@syncengine/core/auth-provider` surface defines the adapter interface. A server-only `resolveAuth(headers, workspaceId)` helper extracts the bearer token, asks the configured provider to verify it, then looks up the verified user's workspace role from the workspace virtual object's `MEMBERS` state. The result is a fully-populated `AuthUser` (id + email + per-workspace roles + claims) that replaces the `null` stub in `entity-runtime.ts`. Unauthenticated RPCs (no token) yield `user: null` — only `Access.public` policies pass.

**Tech Stack:** TypeScript, Vitest. No new runtime dependencies — uses the `jose` library for built-in JWT verification (already transitively available, or we add it).

**Out of scope (later plans):**
- Channel subscription access at the WebSocket layer (Plan 4)
- Reactive `useUser()` hook on the client (Plan 5)
- Real OIDC adapters — Clerk, Auth0, Descope (Plan 6)

---

## File Structure

- **Create:** `packages/core/src/auth-provider.ts` — `AuthProvider` interface + `AuthProviderConfig` type
- **Modify:** `packages/core/src/config.ts` — add `auth?: { provider: AuthProvider }` to `SyncengineConfig`
- **Modify:** `packages/core/src/index.ts` — re-export the auth-provider surface
- **Create:** `packages/server/src/auth/` directory with:
    - `resolve-auth.ts` — the request-path helper that verifies the token and enriches with workspace role
    - `custom-adapter.ts` — the built-in `custom({ verify })` adapter
    - `unverified-adapter.ts` — dev-only pass-through (`Authorization: Bearer <userId>` → `{ id: userId }`)
- **Modify:** `packages/server/src/entity-runtime.ts` — call `resolveAuth` and thread the real user through
- **Modify:** `packages/server/src/workspace/workspace.ts` — expose a `getMemberRole` read handler the auth path can invoke
- **Create:** `packages/server/src/__tests__/auth/` — tests for each adapter + resolveAuth integration
- **Modify:** `packages/core/src/__tests__/auth-provider.test.ts` — interface shape tests

---

## Task 1: `AuthProvider` port interface in core

Define the adapter contract. Pure types — no runtime.

**Files:**
- Create: `packages/core/src/auth-provider.ts`
- Create: `packages/core/src/__tests__/auth-provider.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing tests**

`packages/core/src/__tests__/auth-provider.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { AuthProvider, AuthVerifyResult } from '../auth-provider';

describe('AuthProvider interface', () => {
    it('accepts a conforming object with a verify function', () => {
        const provider: AuthProvider = {
            name: 'test',
            verify: async (token) => ({
                ok: true,
                user: { id: 'u1', email: 'alice@example.com', claims: {} },
            }),
        };
        expect(provider.name).toBe('test');
    });

    it('AuthVerifyResult discriminates on ok: true | false', () => {
        const ok: AuthVerifyResult = { ok: true, user: { id: 'u' } };
        const err: AuthVerifyResult = { ok: false, reason: 'expired' };
        expect(ok.ok).toBe(true);
        expect(err.ok).toBe(false);
    });
});
```

- [ ] **Step 2: Run — verify failure**

`pnpm --filter @syncengine/core test auth-provider -- --run`

Expected: Import of `auth-provider` fails — file doesn't exist.

- [ ] **Step 3: Implement**

`packages/core/src/auth-provider.ts`:

```typescript
/**
 * Auth provider port — the adapter contract between Hexo and an external
 * identity system (Clerk, Auth0, custom JWT, in-memory dev stub).
 *
 * The framework owns authorization (Access DSL, policies). Providers own
 * authentication — verifying the bearer token and returning the user id +
 * claims. Workspace role lookup is separate (see server/auth/resolve-auth).
 */
import type { AuthUser } from './auth';

export type AuthVerifyResult =
    | { readonly ok: true; readonly user: Omit<AuthUser, 'roles'> }
    | { readonly ok: false; readonly reason: string };

export interface AuthProvider {
    /** Adapter name — surfaced in logs and error messages. */
    readonly name: string;
    /** Verify a bearer token. Return the user (without roles — server
     *  enriches from workspace membership) or a reason on rejection. */
    verify(token: string): Promise<AuthVerifyResult>;
    /** Optional: refresh an expired token. Returns a new token string
     *  or `null` if refresh is not supported / the session is dead. */
    refresh?(token: string): Promise<string | null>;
}
```

- [ ] **Step 4: Re-export from the package root**

In `packages/core/src/index.ts`, add next to the auth foundation exports:

```typescript
export type { AuthProvider, AuthVerifyResult } from './auth-provider';
```

- [ ] **Step 5: Run — verify pass**

`pnpm --filter @syncengine/core test auth-provider -- --run`

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/auth-provider.ts packages/core/src/__tests__/auth-provider.test.ts packages/core/src/index.ts
git commit -m "feat(core): AuthProvider port interface + AuthVerifyResult"
```

---

## Task 2: Add `auth` to `SyncengineConfig`

Wire the provider into the top-level config so apps can declare it in `syncengine.config.ts`.

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/__tests__/config.test.ts`

- [ ] **Step 1: Write failing test**

Append to `packages/core/src/__tests__/config.test.ts`:

```typescript
describe('SyncengineConfig.auth', () => {
    it('accepts an auth.provider field', () => {
        const provider: AuthProvider = {
            name: 'stub',
            verify: async () => ({ ok: true, user: { id: 'u' } }),
        };
        const cfg = config({
            workspaces: { resolve: () => 'default' },
            auth: { provider },
        });
        expect(cfg.auth?.provider.name).toBe('stub');
    });

    it('auth is optional (no provider is fine — unauthenticated app)', () => {
        const cfg = config({ workspaces: { resolve: () => 'default' } });
        expect(cfg.auth).toBeUndefined();
    });
});
```

Add to imports: `import type { AuthProvider } from '../auth-provider';`

- [ ] **Step 2: Run — verify failure**

`pnpm --filter @syncengine/core test config -- --run`

Expected: `auth` not a known key on `SyncengineConfig`.

- [ ] **Step 3: Implement**

In `packages/core/src/config.ts`:

1. Import: `import type { AuthProvider } from './auth-provider';`
2. Add to `SyncengineConfig` interface:

```typescript
/** Optional auth provider. When omitted, all requests are unauthenticated
 *  (user: null). Only Access.public policies pass — other policies fail
 *  closed. */
readonly auth?: {
    readonly provider: AuthProvider;
};
```

3. In the `config()` factory, pass `auth` through untouched (it's a plain data field).

- [ ] **Step 4: Run — verify pass**

`pnpm --filter @syncengine/core test config -- --run`

Expected: 2 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/__tests__/config.test.ts
git commit -m "feat(core): SyncengineConfig.auth.provider field"
```

---

## Task 3: Built-in `custom()` adapter

A JWT-agnostic adapter — the caller supplies the verify function. No library dependency.

**Files:**
- Create: `packages/server/src/auth/custom-adapter.ts`
- Create: `packages/server/src/__tests__/auth/custom-adapter.test.ts`
- Modify: `packages/server/src/index.ts` — re-export

- [ ] **Step 1: Write failing test**

`packages/server/src/__tests__/auth/custom-adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { custom } from '../../auth/custom-adapter';

describe('custom() auth adapter', () => {
    it('delegates to the user-supplied verify function', async () => {
        const provider = custom({
            verify: async (token) => {
                if (token === 'alice-token') {
                    return { ok: true, user: { id: 'alice' } };
                }
                return { ok: false, reason: 'invalid' };
            },
        });
        expect(provider.name).toBe('custom');
        const ok = await provider.verify('alice-token');
        expect(ok).toEqual({ ok: true, user: { id: 'alice' } });
        const bad = await provider.verify('garbage');
        expect(bad).toEqual({ ok: false, reason: 'invalid' });
    });

    it('passes through optional refresh handler', async () => {
        const provider = custom({
            verify: async () => ({ ok: false, reason: 'expired' }),
            refresh: async (token) => (token === 'r1' ? 'new-token' : null),
        });
        expect(await provider.refresh!('r1')).toBe('new-token');
        expect(await provider.refresh!('unknown')).toBeNull();
    });

    it('refresh is undefined when not provided', () => {
        const provider = custom({
            verify: async () => ({ ok: true, user: { id: 'u' } }),
        });
        expect(provider.refresh).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run — verify failure**

`pnpm --filter @syncengine/server test custom-adapter -- --run`

Expected: Import fails.

- [ ] **Step 3: Implement**

`packages/server/src/auth/custom-adapter.ts`:

```typescript
import type { AuthProvider, AuthVerifyResult } from '@syncengine/core';

/**
 * Custom auth adapter — the caller supplies the verify function (and
 * optionally a refresh function). Use this when you have an existing
 * JWT library, a custom session store, or any verification strategy
 * that doesn't fit a standard OIDC flow.
 *
 * For OIDC providers (Clerk, Auth0, Descope), Plan 6 ships dedicated
 * adapters that wrap their SDKs.
 */
export function custom(opts: {
    verify: (token: string) => Promise<AuthVerifyResult>;
    refresh?: (token: string) => Promise<string | null>;
}): AuthProvider {
    const provider: AuthProvider = {
        name: 'custom',
        verify: opts.verify,
    };
    if (opts.refresh) {
        (provider as { refresh?: typeof opts.refresh }).refresh = opts.refresh;
    }
    return provider;
}
```

- [ ] **Step 4: Re-export from the server package**

In `packages/server/src/index.ts`, add (find the appropriate export section):

```typescript
export { custom } from './auth/custom-adapter';
```

- [ ] **Step 5: Run — verify pass**

`pnpm --filter @syncengine/server test custom-adapter -- --run`

Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/auth/custom-adapter.ts packages/server/src/__tests__/auth/ packages/server/src/index.ts
git commit -m "feat(server): custom() auth adapter — pluggable verify function"
```

---

## Task 4: Built-in `unverified()` dev adapter

A pass-through for local dev and tests. Trusts the bearer token *as* the user id. Must never be used in production — emits a loud console warning at boot.

**Files:**
- Create: `packages/server/src/auth/unverified-adapter.ts`
- Create: `packages/server/src/__tests__/auth/unverified-adapter.test.ts`

- [ ] **Step 1: Write failing test**

`packages/server/src/__tests__/auth/unverified-adapter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unverified } from '../../auth/unverified-adapter';

describe('unverified() dev auth adapter', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warnSpy.mockRestore(); });

    it('trusts the bearer token as the user id', async () => {
        const provider = unverified();
        const result = await provider.verify('alice');
        expect(result).toEqual({ ok: true, user: { id: 'alice' } });
    });

    it('rejects empty tokens', async () => {
        const provider = unverified();
        const result = await provider.verify('');
        expect(result.ok).toBe(false);
    });

    it('name is "unverified" so logs are obvious', () => {
        const provider = unverified();
        expect(provider.name).toBe('unverified');
    });

    it('warns at construction time — production guardrail', () => {
        unverified();
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls[0]![0]).toMatch(/unverified/i);
    });
});
```

- [ ] **Step 2: Run — verify failure**

`pnpm --filter @syncengine/server test unverified-adapter -- --run`

- [ ] **Step 3: Implement**

`packages/server/src/auth/unverified-adapter.ts`:

```typescript
import type { AuthProvider } from '@syncengine/core';

/**
 * Dev-only pass-through adapter. Treats the bearer token literally as
 * the user id — no signature check, no expiry, no claims. Useful for
 * local development, integration tests, and quick demos.
 *
 * Logs a loud warning at construction so production deployments that
 * accidentally ship with this adapter are caught in boot logs.
 */
export function unverified(): AuthProvider {
    console.warn(
        '[syncengine] auth: unverified() adapter is in use. Tokens are ' +
        'NOT cryptographically verified — use custom() with a real verify ' +
        'function in production.',
    );
    return {
        name: 'unverified',
        verify: async (token) => {
            if (!token) return { ok: false, reason: 'empty token' };
            return { ok: true, user: { id: token } };
        },
    };
}
```

- [ ] **Step 4: Re-export**

In `packages/server/src/index.ts`:

```typescript
export { unverified } from './auth/unverified-adapter';
```

- [ ] **Step 5: Run — verify pass**

`pnpm --filter @syncengine/server test unverified-adapter -- --run`

Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/auth/unverified-adapter.ts packages/server/src/__tests__/auth/ packages/server/src/index.ts
git commit -m "feat(server): unverified() dev adapter — bearer token IS the userId"
```

---

## Task 5: Workspace `getMemberRole` read-only handler

Expose workspace membership role lookup so `resolveAuth` can enrich the verified user. The workspace virtual object already stores members — this task just adds a typed read surface.

**Files:**
- Modify: `packages/server/src/workspace/workspace.ts`
- Modify: `packages/server/src/workspace/__tests__/workspace.test.ts` (or wherever the existing tests live — locate them first)

- [ ] **Step 1: Locate the existing workspace tests**

Run: `find packages/server -name "*.test.ts" | xargs grep -l "MEMBERS\|isMember\|addMember"`

Work with the existing file if one exists; otherwise add to the closest test file for the workspace object.

- [ ] **Step 2: Write failing test**

Use the existing workspace test harness to provision a workspace with a creator, then:

```typescript
it('getMemberRole returns the member role for the creator', async () => {
    // ... provision workspace with creatorUserId: 'alice'
    const role = await workspaceHandlers.getMemberRole(ctx, { userId: 'alice' });
    expect(role).toEqual({ role: 'owner' });
});

it('getMemberRole returns null for a non-member', async () => {
    const role = await workspaceHandlers.getMemberRole(ctx, { userId: 'stranger' });
    expect(role).toEqual({ role: null });
});
```

- [ ] **Step 3: Implement**

In `packages/server/src/workspace/workspace.ts`, add a handler in the object definition (find `async isMember` for placement):

```typescript
async getMemberRole(
    ctx: restate.ObjectContext,
    req: { userId: string },
): Promise<{ role: string | null }> {
    await ensureActive(ctx);
    const members = await getMembers(ctx);
    const member = members.find((m) => m.userId === req.userId);
    return { role: member?.role ?? null };
},
```

- [ ] **Step 4: Run tests — verify they pass**

`pnpm --filter @syncengine/server test workspace -- --run`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/workspace/
git commit -m "feat(server): workspace.getMemberRole(userId) read handler"
```

---

## Task 6: `resolveAuth()` — verify token + enrich with role

The request-path helper that stitches provider verification with workspace membership.

**Files:**
- Create: `packages/server/src/auth/resolve-auth.ts`
- Create: `packages/server/src/__tests__/auth/resolve-auth.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/server/src/__tests__/auth/resolve-auth.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { resolveAuth } from '../../auth/resolve-auth';
import { unverified } from '../../auth/unverified-adapter';

describe('resolveAuth', () => {
    it('returns null user when provider is undefined', async () => {
        const user = await resolveAuth({
            provider: undefined,
            authHeader: 'Bearer alice',
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user).toBeNull();
    });

    it('returns null user when no Authorization header', async () => {
        const user = await resolveAuth({
            provider: unverified(),
            authHeader: undefined,
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user).toBeNull();
    });

    it('verifies token + enriches with workspace role', async () => {
        const lookupRole = vi.fn().mockResolvedValue('admin');
        const user = await resolveAuth({
            provider: unverified(),
            authHeader: 'Bearer alice',
            workspaceId: 'ws1',
            lookupRole,
        });
        expect(user).toEqual({ id: 'alice', roles: ['admin'] });
        expect(lookupRole).toHaveBeenCalledWith('alice', 'ws1');
    });

    it('verified user with no workspace membership has empty roles', async () => {
        const user = await resolveAuth({
            provider: unverified(),
            authHeader: 'Bearer stranger',
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user).toEqual({ id: 'stranger', roles: [] });
    });

    it('rejected token yields null user', async () => {
        const provider = {
            name: 'fail',
            verify: async () => ({ ok: false as const, reason: 'expired' }),
        };
        const user = await resolveAuth({
            provider,
            authHeader: 'Bearer anything',
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user).toBeNull();
    });

    it('parses the bearer prefix case-insensitively', async () => {
        const user = await resolveAuth({
            provider: unverified(),
            authHeader: 'bearer alice',
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user?.id).toBe('alice');
    });
});
```

- [ ] **Step 2: Run — verify failure**

- [ ] **Step 3: Implement**

`packages/server/src/auth/resolve-auth.ts`:

```typescript
import type { AuthProvider, AuthUser } from '@syncengine/core';

/**
 * Verify an incoming Authorization header and enrich the resulting user
 * with their per-workspace role. Returns null when:
 *   - no provider is configured (pre-auth app)
 *   - no Authorization header is present (unauthenticated request)
 *   - the provider rejects the token
 *
 * The null path intentionally does NOT throw — Access.public handlers
 * should still work for unauthenticated callers. Policies that require
 * a user (authenticated, role, owner) reject the null user themselves.
 */
export async function resolveAuth(input: {
    provider: AuthProvider | undefined;
    authHeader: string | undefined;
    workspaceId: string;
    lookupRole: (userId: string, workspaceId: string) => Promise<string | null>;
}): Promise<AuthUser | null> {
    if (!input.provider) return null;

    const token = extractBearer(input.authHeader);
    if (!token) return null;

    const result = await input.provider.verify(token);
    if (!result.ok) return null;

    const role = await input.lookupRole(result.user.id, input.workspaceId);
    return {
        ...result.user,
        roles: role ? [role] : [],
    };
}

function extractBearer(header: string | undefined): string | null {
    if (!header) return null;
    const match = header.match(/^bearer\s+(.+)$/i);
    return match ? match[1]!.trim() : null;
}
```

- [ ] **Step 4: Run — verify pass**

`pnpm --filter @syncengine/server test resolve-auth -- --run`

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth/resolve-auth.ts packages/server/src/__tests__/auth/
git commit -m "feat(server): resolveAuth — verify token + workspace role enrichment"
```

---

## Task 7: Entity runtime uses `resolveAuth` instead of the null stub

Wire everything through: the RPC handler now extracts the Authorization header, calls `resolveAuth`, and passes the real user to `applyHandler`.

**Files:**
- Modify: `packages/server/src/entity-runtime.ts`
- Modify: `packages/server/src/__tests__/entity-runtime.test.ts`

- [ ] **Step 1: Locate how Restate exposes request headers**

Run: `grep -n "ctx.request\|headers\|Authorization" packages/server/src/entity-runtime.ts`

Restate's `ObjectContext` exposes `ctx.request()` (or similar — verify against the restate-sdk version in use). The auth token arrives as a header on the Restate ingress POST.

- [ ] **Step 2: Write integration test**

Append to `packages/server/src/__tests__/entity-runtime.test.ts`:

```typescript
describe('entity runtime — authenticated handler invocation', () => {
    it('threads the verified user id into handler auth context', async () => {
        // The runHandler implementation now reads auth. Test with a
        // mock ctx that exposes an auth header and a mock workspace
        // role lookup. The specifics depend on how ctx.request() /
        // auth plumbing is structured — follow the pattern of the
        // existing entity-runtime tests.
    });
});
```

*Exact test implementation depends on the existing test harness. If there's no way to simulate the auth header without refactoring, split this task into 7a (extract `runHandler` so it takes auth as a param) and 7b (wire `ctx.request()` at the outermost Restate entrypoint).*

- [ ] **Step 3: Implement**

In `packages/server/src/entity-runtime.ts`:

1. Import `resolveAuth` and the configured provider (pulled from the loaded `SyncengineConfig`).
2. Before calling `applyHandler`, extract the auth header from `ctx.request().headers` (SDK-specific — check `@restatedev/restate-sdk` types), call `resolveAuth`, and use the result.
3. The `lookupRole` callback invokes the workspace virtual object's `getMemberRole` handler via the Restate client.

Replace the existing `user: null` stub at line ~91:

```typescript
const user = await resolveAuth({
    provider: config.auth?.provider,
    authHeader: ctx.request().headers.get('authorization') ?? undefined,
    workspaceId,
    lookupRole: async (userId, wsId) => {
        // Call the workspace object's getMemberRole handler
        const result = await ctx
            .objectClient({ name: 'workspace' }, wsId)
            .getMemberRole({ userId });
        return result.role;
    },
});

validated = applyHandler(entity, handlerName, merged, args, {
    user,
    key: entityKey,
});
```

Resolve `$user` placeholder substitution using the real user id:

```typescript
const emits = rawEmits
    ? resolveEmitPlaceholders(rawEmits, {
          entityKey,
          userId: user?.id ?? null,
      })
    : undefined;
```

- [ ] **Step 4: Run — verify tests pass**

`pnpm --filter @syncengine/server test entity-runtime -- --run`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/entity-runtime.ts packages/server/src/__tests__/entity-runtime.test.ts
git commit -m "feat(server): entity runtime resolves auth via configured provider"
```

---

## Task 8: Client passes the auth token to the RPC POST

The client already has `runtimeAuthToken`. Thread it into the `Authorization: Bearer …` header for every RPC call.

**Files:**
- Modify: `packages/client/src/entity-client.ts` — the `invokeHandler` function that POSTs to Restate
- Modify: the relevant client tests

- [ ] **Step 1: Locate `invokeHandler` / the fetch call**

Run: `grep -n "fetch\|invokeHandler" packages/client/src/entity-client.ts`

- [ ] **Step 2: Write failing test (if the existing suite covers header propagation)**

Check if `packages/client/src/__tests__/auth-isolation.test.ts` already asserts `Authorization` header on entity RPC. If yes, ensure the test covers the new handler-level POST. If no, add one.

- [ ] **Step 3: Implement**

In `invokeHandler` (or wherever the RPC POST lives), set the header:

```typescript
const headers: Record<string, string> = {
    'Content-Type': 'application/json',
};
if (runtimeAuthToken) {
    headers['Authorization'] = `Bearer ${runtimeAuthToken}`;
}
```

- [ ] **Step 4: Run — verify pass**

`pnpm --filter @syncengine/client test -- --run`

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/entity-client.ts packages/client/src/__tests__/
git commit -m "feat(client): include Authorization header on entity RPC POSTs"
```

---

## Task 9: Full workspace verification

- [ ] Build: `pnpm -w build`
- [ ] Test: `pnpm -r --if-present test -- --run`
- [ ] Typecheck: `pnpm -r --if-present typecheck`

Expected: all clean except the pre-existing `packages/client` store test failure (unrelated).

---

## Definition of Done

- `AuthProvider` interface + `AuthVerifyResult` type exported from `@syncengine/core`
- `SyncengineConfig.auth.provider` accepted by the top-level config
- `custom({ verify, refresh? })` adapter ships from `@syncengine/server`
- `unverified()` adapter ships from `@syncengine/server` with a loud boot warning
- `workspace.getMemberRole(userId)` returns the user's per-workspace role
- `resolveAuth(...)` verifies the token + enriches with workspace role, returns `AuthUser | null`
- Entity runtime wires `resolveAuth` into every handler invocation — no more `user: null` stub
- Client sends `Authorization: Bearer <token>` on RPC POSTs
- `$user` placeholder resolves to the authenticated user id in emitted rows
- Full workspace build + tests pass (except pre-existing unrelated failure)

## What This Plan Does NOT Do

- **No channel access.** Plan 4 adds subscription-time `access` predicates on channels, plus the WebSocket-level auth upgrade.
- **No reactive `useUser()` hook.** Plan 5 introduces it and wires into `setCurrentUserGetter`.
- **No OIDC adapters.** Plan 6 ships `@hexo/auth-clerk` et al. For now, apps can use `custom()` to wrap any existing JWT library.
- **No token refresh on the wire.** The adapter interface exposes `refresh()`, but the client-side refresh loop is a separate concern handled in Plan 5.

## Subsequent Plans

| # | Plan | What it adds |
|---|------|-------------|
| 4 | Channel Access | Subscription-time access predicate on channels, WebSocket handshake verification |
| 5 | Client SDK | `useUser()` hook, token lifecycle (refresh + reconnect), wiring into `setCurrentUserGetter` |
| 6 | Provider Adapters | `@hexo/auth-clerk` (native), `@hexo/auth-auth0`, etc. |
