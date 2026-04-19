# Auth — Channel Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Verify the WebSocket handshake's auth token at the gateway, then enforce a per-channel `access` predicate at subscription time. Reject unauthorized channel subscribes before any data reaches the client.

**Architecture:** `channel()` accepts an optional `access: AccessPolicy`. `@syncengine/gateway-core` — which lives in its own package and intentionally doesn't depend on `@syncengine/server` — is extended with a pluggable `AuthHook` injection point: a `verifyInit(authToken, workspaceId)` callback that returns the verified `AuthUser | null`, and an `authorizeChannel(user, channelName)` callback that the host wires to the channel registry. Both are called from within `attach()` before `bridge.ensureChannelConsumer(...)`. The concrete wiring (to `resolveAuth` + channel registry) lives in `@syncengine/server`'s serve entry.

**Tech Stack:** TypeScript, Vitest. Builds on Plans 1-3 (AccessPolicy, AuthProvider, resolveAuth).

**Out of scope:**
- Reactive `useUser()` hook on the client (Plan 5 — includes ACCESS_DENIED surfacing on subscribe failures)
- Real OIDC adapters (Plan 6)

---

## File Structure

- **Modify:** `packages/core/src/channels.ts` — add `access?: AccessPolicy` to `ChannelConfig`
- **Modify:** `packages/core/src/__tests__/channels.test.ts` — config shape tests
- **Modify:** `packages/gateway-core/src/gateway-core.ts` — inject `AuthHook`, verify at init, authorize at subscribe
- **Modify:** `packages/gateway-core/src/protocol.ts` — (optional) standardise the `code` field on error frames
- **Create:** `packages/gateway-core/src/auth-hook.ts` — the injection-point type
- **Modify:** `packages/gateway-core/src/__tests__/` — gateway auth tests
- **Modify:** `packages/server/src/serve.ts` (or wherever the gateway is constructed) — wire the hook to `resolveAuth` + a channel registry

---

## Task 1: `channel()` accepts an `access` predicate

**Files:**
- Modify: `packages/core/src/channels.ts`
- Modify: `packages/core/src/__tests__/channels.test.ts`

- [ ] **Step 1: Write failing tests**

Find the existing channels test and append:

```typescript
import { Access } from '../auth';

describe('channel() access policy', () => {
    it('accepts an access policy in options', () => {
        const admin = channel('admin', [someTable], { access: Access.role('admin') });
        expect(admin.$access?.$kind).toBe('access');
    });

    it('defaults $access to null when omitted', () => {
        const plain = channel('plain', [someTable]);
        expect(plain.$access).toBeNull();
    });
});
```

- [ ] **Step 2: Run — verify failure**

`pnpm --filter @syncengine/core test channels -- --run`

- [ ] **Step 3: Implement**

In `packages/core/src/channels.ts`:

1. Import `AccessPolicy` type:

```typescript
import type { AccessPolicy } from './auth';
```

2. Add `access?: AccessPolicy` to `ChannelConfig`:

```typescript
export interface ChannelConfig<TName extends string = string> {
    readonly name: TName;
    readonly tables: readonly AnyTable[];
    /** Access policy evaluated at subscription time. null = public to
     *  every workspace member. Enforcement lives in the gateway. */
    readonly $access: AccessPolicy | null;
}
```

3. Update `channel()` factory to accept an options bag:

```typescript
export function channel<const TName extends string>(
    name: TName,
    tables: readonly AnyTable[],
    opts?: { access?: AccessPolicy },
): ChannelConfig<TName> {
    return {
        name,
        tables,
        $access: opts?.access ?? null,
    };
}
```

- [ ] **Step 4: Run — verify pass**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/channels.ts packages/core/src/__tests__/channels.test.ts
git commit -m "feat(core): channel() accepts access policy for subscription-time enforcement"
```

---

## Task 2: `AuthHook` injection point in gateway-core

gateway-core is runtime-agnostic. It can't depend on `@syncengine/server`'s `resolveAuth` or workspace client. Instead, expose a hook the host fills in.

**Files:**
- Create: `packages/gateway-core/src/auth-hook.ts`
- Modify: `packages/gateway-core/src/index.ts` — re-export

- [ ] **Step 1: Create the type**

`packages/gateway-core/src/auth-hook.ts`:

```typescript
import type { AuthUser } from '@syncengine/core';

/**
 * Host-provided callback that verifies an init-time auth token and
 * returns the verified user (with per-workspace roles populated) or
 * null for unauthenticated callers. Runs once per WebSocket init.
 *
 * Injected at GatewayCore construction so gateway-core stays
 * runtime-agnostic (no dependency on @syncengine/server).
 */
export type VerifyInitFn = (
    authToken: string | undefined,
    workspaceId: string,
) => Promise<AuthUser | null>;

/**
 * Host-provided callback that checks whether the verified user may
 * subscribe to the named channel. Called inside `attach()` before
 * any consumer is spun up. Returning `false` triggers an error frame
 * to the client and skips the subscription.
 *
 * The host reads the channel's `$access` policy from its registry
 * and evaluates it. gateway-core doesn't know what channels exist.
 */
export type AuthorizeChannelFn = (
    user: AuthUser | null,
    workspaceId: string,
    channelName: string,
) => Promise<boolean>;

export interface AuthHook {
    readonly verifyInit: VerifyInitFn;
    readonly authorizeChannel: AuthorizeChannelFn;
}
```

- [ ] **Step 2: Re-export**

In `packages/gateway-core/src/index.ts`, add:

```typescript
export type { AuthHook, VerifyInitFn, AuthorizeChannelFn } from './auth-hook';
```

- [ ] **Step 3: Commit**

```bash
git add packages/gateway-core/src/auth-hook.ts packages/gateway-core/src/index.ts
git commit -m "feat(gateway-core): AuthHook injection point — verifyInit + authorizeChannel"
```

---

## Task 3: Wire `AuthHook` into `GatewayCore.attach()`

Verify at `init`, reject on failure. Check `authorizeChannel` at every `subscribe` of kind `'channel'`.

**Files:**
- Modify: `packages/gateway-core/src/gateway-core.ts`
- Modify: `packages/gateway-core/src/__tests__/gateway-auth.test.ts` (create if missing)

- [ ] **Step 1: Write failing tests**

Create `packages/gateway-core/src/__tests__/gateway-auth.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { GatewayCore } from '../gateway-core';
import type { AuthHook } from '../auth-hook';

function makeFakeWs() {
    const sent: string[] = [];
    return {
        sent,
        ws: {
            send: (msg: string) => { sent.push(msg); },
            close: () => {},
        } as any,
    };
}

describe('GatewayCore auth', () => {
    it('accepts a valid init when verifyInit returns a user', async () => {
        const hook: AuthHook = {
            verifyInit: vi.fn().mockResolvedValue({ id: 'alice', roles: ['member'] }),
            authorizeChannel: vi.fn().mockResolvedValue(true),
        };
        const core = new GatewayCore({ authHook: hook, /* other opts */ });
        const { ws, sent } = makeFakeWs();
        const session = core.attach(ws);
        await session.handleMessage(JSON.stringify({
            type: 'init',
            clientId: 'c1',
            workspaceId: 'ws1',
            authToken: 'alice-token',
            channels: [],
        }));
        expect(sent.some(s => s.includes('"ready"'))).toBe(true);
    });

    it('rejects init when verifyInit returns null', async () => {
        const hook: AuthHook = {
            verifyInit: vi.fn().mockResolvedValue(null),
            authorizeChannel: vi.fn().mockResolvedValue(false),
        };
        const core = new GatewayCore({ authHook: hook });
        const { ws, sent } = makeFakeWs();
        const session = core.attach(ws);
        await session.handleMessage(JSON.stringify({
            type: 'init',
            clientId: 'c1',
            workspaceId: 'ws1',
            authToken: 'bad-token',
            channels: [],
        }));
        expect(sent.some(s => s.includes('UNAUTHORIZED'))).toBe(true);
    });

    it('rejects a channel subscribe when authorizeChannel returns false', async () => {
        const hook: AuthHook = {
            verifyInit: vi.fn().mockResolvedValue({ id: 'alice', roles: ['viewer'] }),
            authorizeChannel: vi.fn().mockImplementation(async (_u, _w, ch) => ch !== 'admin'),
        };
        const core = new GatewayCore({ authHook: hook });
        const { ws, sent } = makeFakeWs();
        const session = core.attach(ws);
        await session.handleMessage(JSON.stringify({
            type: 'init',
            clientId: 'c1',
            workspaceId: 'ws1',
            authToken: 'alice',
            channels: [],
        }));
        sent.length = 0;  // clear ready frame
        await session.handleMessage(JSON.stringify({
            type: 'subscribe',
            kind: 'channel',
            name: 'admin',
        }));
        expect(sent.some(s => s.includes('ACCESS_DENIED'))).toBe(true);
    });
});
```

Adjust to match the actual `GatewayCore` constructor signature — look at the existing file to find what options it takes.

- [ ] **Step 2: Implement**

In `packages/gateway-core/src/gateway-core.ts`:

1. Accept `authHook` in the constructor options.

2. In the `init` branch of `handleMessage`, before creating the session:

```typescript
if (msg.type === 'init') {
    // ... existing validation ...
    const init = msg as ClientInitMessage;
    const user = await this.authHook.verifyInit(init.authToken, init.workspaceId);
    if (this.authHook && user === null && init.authToken) {
        // Token was provided but rejected — fail closed.
        closeWith('Unauthorized', 'UNAUTHORIZED');
        return;
    }
    // Store user on the session for later authorizeChannel calls.
    session = new ClientSession(init.clientId, ws);
    session.user = user;  // add this field to ClientSession
    // ... rest unchanged ...
```

3. On every `subscribe` with `kind === 'channel'`:

```typescript
case 'subscribe':
    if (msg.kind === 'channel') {
        const allowed = await this.authHook.authorizeChannel(
            session.user ?? null,
            session.workspaceId,
            msg.name,
        );
        if (!allowed) {
            ws.send(JSON.stringify({
                type: 'error',
                message: `Access denied for channel '${msg.name}'`,
                code: 'ACCESS_DENIED',
            }));
            return;
        }
        // ... existing subscription logic ...
    }
```

4. If `authHook` is not provided (pre-auth apps), use default pass-through callbacks that return `null` user and `true` on authorize — preserves current behavior.

- [ ] **Step 3: Run tests — verify pass**

- [ ] **Step 4: Commit**

```bash
git add packages/gateway-core/src/
git commit -m "feat(gateway-core): auth hook — verify init token, authorize channel subscribes"
```

---

## Task 4: Host wiring — connect the hook to resolveAuth + channel registry

The `@syncengine/server` side registers a channel registry (list of ChannelConfig loaded at boot) and provides the `AuthHook` implementation.

**Files:**
- Modify: `packages/server/src/serve.ts` (or the module that constructs `GatewayCore`)
- Create: `packages/server/src/auth/channel-registry.ts` — module-level channel list

- [ ] **Step 1: Find where `GatewayCore` is constructed**

Run: `grep -rn "new GatewayCore\|GatewayServer" packages/server/src/ | head -5`

Wire the AuthHook there.

- [ ] **Step 2: Implement a channel registry**

`packages/server/src/auth/channel-registry.ts`:

```typescript
import type { ChannelConfig, AccessPolicy, AccessContext } from '@syncengine/core';

let _channels: readonly ChannelConfig[] = [];

export function registerChannels(channels: readonly ChannelConfig[]): void {
    _channels = channels;
}

/** Look up a channel's access policy by name. Returns null for
 *  unknown channels (treated as public pass-through) or channels
 *  without an access policy declared. */
export function getChannelAccess(name: string): AccessPolicy | null {
    const ch = _channels.find((c) => c.name === name);
    return ch?.$access ?? null;
}
```

- [ ] **Step 3: Build and pass the AuthHook**

Where the gateway is constructed:

```typescript
import { resolveAuth } from './auth/resolve-auth.js';
import { getChannelAccess } from './auth/channel-registry.js';

const authHook: AuthHook = {
    verifyInit: async (authToken, workspaceId) => {
        return resolveAuth({
            provider: appConfig.auth?.provider,
            authHeader: authToken ? `Bearer ${authToken}` : undefined,
            workspaceId,
            lookupRole: async (userId, wsId) => {
                // Call workspace.isMember via the restate client — not the
                // in-context objectClient; this is from a plain node
                // process, so use the external restate-sdk-clients.
                // Pattern may already exist elsewhere in serve.ts —
                // check for workspaceClient / IngressClient.
                const result = await /* ... */;
                return result.role ?? null;
            },
        });
    },
    authorizeChannel: async (user, _wsId, channelName) => {
        const policy = getChannelAccess(channelName);
        if (!policy) return true;  // no policy = public
        return policy.check({
            user,
            key: channelName,
            // Channels have no per-instance state for ownership checks,
            // so state is undefined.
        });
    },
};

const gateway = new GatewayCore({ authHook, /* ... */ });
```

*If the workspace RPC from outside Restate is non-trivial, fall back to a simpler version: call `appConfig.auth?.provider?.verify(authToken)` and skip the role enrichment for v1. The workspace lookup can land in a follow-up.*

- [ ] **Step 4: Call `registerChannels` at boot**

Find where the channel list is assembled (likely in the loader that also registers entities/workflows) and call `registerChannels(channels)` once.

- [ ] **Step 5: Run the workspace build + tests**

`pnpm -w build && pnpm -r --if-present test -- --run`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/
git commit -m "feat(server): wire channel registry + AuthHook into GatewayCore"
```

---

## Task 5: E2E smoke test

- [ ] Test end-to-end: scaffold a minimal app with one restricted channel + unverified() adapter. Verify a viewer cannot subscribe to an admin channel; an admin can.

---

## Task 6: Full workspace verification

- [ ] Build, tests, typecheck — all clean.

---

## Definition of Done

- `channel(name, tables, { access })` accepts a policy, stored on `$access`
- `AuthHook` type exported from `@syncengine/gateway-core`
- gateway verifies init token via injected hook, rejects on failure
- gateway evaluates channel policies on every `subscribe` of `kind: 'channel'`
- serve wiring: channel registry loaded at boot, hook passed to `GatewayCore`
- full workspace build + tests pass (except pre-existing unrelated failure)

## What This Plan Does NOT Do

- **Client-side surfacing of ACCESS_DENIED on subscribe.** Plan 5 adds useUser() + surfaces subscription errors through the entity/view hooks.
- **Real OIDC adapters.** Plan 6.
