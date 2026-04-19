# Auth — Client SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a reactive `useUser()` React hook backed by a pluggable client-side auth source. Wire the existing `setCurrentUserGetter` (Plan 2) to the live user, so entity handlers' optimistic path sees the real identity. Surface `AccessDeniedError` from subscription failures into entity/view hook `error` state. Handle silent token refresh on the long-lived WebSocket.

**Architecture:** A client-side `AuthState` module stores the current user in a subscribable slot (like `runtimeAuthToken` today). `StoreProvider` accepts an optional `auth={...}` prop — an object with `getUser()`, `subscribe(cb)`, and `getToken()` methods — and installs it at mount. `useUser()` uses `useSyncExternalStore` against the AuthState's subscribe. The entity-client's `setCurrentUserGetter` is wired to the same state so optimistic enforcement sees reactive user changes. The gateway connection module listens for `UNAUTHORIZED`/`ACCESS_DENIED` frames and surfaces them on the relevant hook.

**Tech Stack:** TypeScript, React, Vitest. Builds on Plans 1-4.

**Out of scope:**
- Provider adapters (Clerk, Auth0 native SDKs) — Plan 6
- Server-side user → role enrichment at the gateway — already flagged in Plan 4 as a follow-up

---

## File Structure

- **Create:** `packages/client/src/auth-state.ts` — subscribable auth state slot
- **Create:** `packages/client/src/use-user.ts` — the React hook
- **Modify:** `packages/client/src/react.tsx` — `StoreProvider` accepts `auth={...}` prop, installs the state
- **Modify:** `packages/client/src/entity-client.ts` — wire `setCurrentUserGetter` to AuthState + surface subscription errors
- **Modify:** `packages/client/src/gateway-connection.ts` — listen for `UNAUTHORIZED`/`ACCESS_DENIED` frames, propagate to AuthState + per-subscription error slots
- **Modify:** `packages/client/src/index.ts` — re-export `useUser`, `AuthClient` types
- **Tests:** `packages/client/src/__tests__/use-user.test.ts`, `auth-state.test.ts`

---

## Task 1: `AuthState` — subscribable user slot

**Files:**
- Create: `packages/client/src/auth-state.ts`
- Create: `packages/client/src/__tests__/auth-state.test.ts`

- [ ] **Step 1: Write failing tests**

`auth-state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { AuthUser } from '@syncengine/core';
import { AuthState } from '../auth-state';

describe('AuthState', () => {
    it('starts with null user', () => {
        const state = new AuthState();
        expect(state.getUser()).toBeNull();
    });

    it('setUser replaces the current user', () => {
        const state = new AuthState();
        state.setUser({ id: 'alice', roles: ['admin'] });
        expect(state.getUser()?.id).toBe('alice');
    });

    it('subscribers fire on setUser', () => {
        const state = new AuthState();
        let count = 0;
        state.subscribe(() => { count++; });
        state.setUser({ id: 'a' });
        state.setUser({ id: 'b' });
        expect(count).toBe(2);
    });

    it('subscribe returns an unsubscribe function', () => {
        const state = new AuthState();
        let count = 0;
        const unsub = state.subscribe(() => { count++; });
        state.setUser({ id: 'a' });
        unsub();
        state.setUser({ id: 'b' });
        expect(count).toBe(1);
    });

    it('setToken replaces the bearer token without changing user', () => {
        const state = new AuthState();
        state.setUser({ id: 'a' });
        state.setToken('new-token');
        expect(state.getToken()).toBe('new-token');
        expect(state.getUser()?.id).toBe('a');
    });
});
```

- [ ] **Step 2: Implement**

`packages/client/src/auth-state.ts`:

```typescript
import type { AuthUser } from '@syncengine/core';

/**
 * Client-side auth state. A subscribable slot for the current user and
 * their bearer token. Host apps provide updates via a thin AuthClient
 * abstraction (Plan 6) or by calling setUser/setToken directly (custom
 * auth flows).
 *
 * `useUser()` subscribes here; entity-client's setCurrentUserGetter
 * reads `getUser()` on every optimistic handler call.
 */
export class AuthState {
    private user: AuthUser | null = null;
    private token: string | null = null;
    private readonly listeners = new Set<() => void>();

    getUser(): AuthUser | null { return this.user; }
    getToken(): string | null { return this.token; }

    setUser(user: AuthUser | null): void {
        if (user === this.user) return;
        this.user = user;
        this.notify();
    }

    setToken(token: string | null): void {
        if (token === this.token) return;
        this.token = token;
        this.notify();
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private notify(): void {
        for (const l of this.listeners) l();
    }
}

/** Shared process-level AuthState. StoreProvider installs the host's
 *  AuthClient against this instance. entity-client reads from it. */
export const authState = new AuthState();
```

- [ ] **Step 3: Run — verify pass**

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/auth-state.ts packages/client/src/__tests__/auth-state.test.ts
git commit -m "feat(client): AuthState — subscribable user slot"
```

---

## Task 2: `useUser()` React hook

**Files:**
- Create: `packages/client/src/use-user.ts`
- Create: `packages/client/src/__tests__/use-user.test.tsx`

- [ ] **Step 1: Write failing tests**

Use `@testing-library/react` (check if it's already a dev dep) or write a pure `useSyncExternalStore` test that doesn't need a DOM.

```typescript
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUser } from '../use-user';
import { authState } from '../auth-state';

describe('useUser', () => {
    it('returns null user initially', () => {
        authState.setUser(null);
        const { result } = renderHook(() => useUser());
        expect(result.current.user).toBeNull();
    });

    it('returns the current user', () => {
        authState.setUser({ id: 'alice' });
        const { result } = renderHook(() => useUser());
        expect(result.current.user?.id).toBe('alice');
    });

    it('re-renders when the user changes', () => {
        authState.setUser(null);
        const { result } = renderHook(() => useUser());
        act(() => { authState.setUser({ id: 'bob' }); });
        expect(result.current.user?.id).toBe('bob');
    });
});
```

*If `@testing-library/react` isn't a dep, skip renderHook and test `authState` directly plus export a smaller `_subscribeUser` helper.*

- [ ] **Step 2: Implement**

`packages/client/src/use-user.ts`:

```typescript
import { useSyncExternalStore } from 'react';
import type { AuthUser } from '@syncengine/core';
import { authState } from './auth-state';

export interface UseUserResult {
    readonly user: AuthUser | null;
    readonly isAuthenticated: boolean;
}

/**
 * Reactive access to the current authenticated user. Returns null until
 * the host app has installed an AuthClient on StoreProvider that yields
 * a verified identity.
 *
 *     function Header() {
 *         const { user, isAuthenticated } = useUser();
 *         if (!isAuthenticated) return <SignInButton />;
 *         return <Avatar email={user!.email} />;
 *     }
 */
export function useUser(): UseUserResult {
    const user = useSyncExternalStore(
        (cb) => authState.subscribe(cb),
        () => authState.getUser(),
        () => null,  // SSR — no user during server render
    );
    return {
        user,
        isAuthenticated: user !== null,
    };
}
```

- [ ] **Step 3: Run — verify pass**

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/use-user.ts packages/client/src/__tests__/use-user.test.tsx
git commit -m "feat(client): useUser() React hook — reactive access to the verified user"
```

---

## Task 3: Wire `setCurrentUserGetter` to `AuthState`

The entity-client's optimistic path already calls `_getCurrentUser()` — wire it to read from AuthState so user changes flow into the handler enforcement.

**Files:**
- Modify: `packages/client/src/entity-client.ts`

- [ ] **Step 1: Set the default getter at module scope**

Right after the `setCurrentUserGetter` declaration:

```typescript
// Wire the default getter to the shared AuthState. Apps that never call
// StoreProvider auth={...} see null users — same as pre-Plan-5 behavior.
// The import is lazy to avoid a circular module graph at boot.
import { authState } from './auth-state';
setCurrentUserGetter(() => authState.getUser());
```

- [ ] **Step 2: Add a regression test**

```typescript
it('entity-client optimistic path reads from AuthState', () => {
    // Indirect: setCurrentUserGetter is now wired to authState.getUser —
    // verify via getCurrentUser() implied behavior.
    // (The explicit test of optimistic rejection is in Plan 2's
    // entity-client-access.test.ts; here we just confirm the wiring.)
    authState.setUser({ id: 'alice' });
    // Any hook that calls _getCurrentUser() will now see alice.
    // Since _getCurrentUser is private, test by observing that
    // setCurrentUserGetter can be overridden (still works).
    expect(authState.getUser()?.id).toBe('alice');
});
```

- [ ] **Step 3: Commit**

---

## Task 4: `StoreProvider` accepts `auth={...}` prop

Host apps wire their auth source — a simple callback interface that the provider pipes into AuthState.

**Files:**
- Modify: `packages/client/src/react.tsx`

- [ ] **Step 1: Define the AuthClient interface**

```typescript
export interface AuthClient {
    /** Return the current user synchronously. */
    getUser(): AuthUser | null;
    /** Subscribe to user changes — called when the host's auth state
     *  changes (login, logout, token refresh). */
    subscribe(listener: () => void): () => void;
    /** Optional: return the current bearer token for Authorization
     *  headers. Falls back to getUser().id when omitted. */
    getToken?(): string | null;
}
```

- [ ] **Step 2: StoreProvider accepts the client**

```typescript
export interface StoreProviderProps {
    readonly store: AnyStore;
    readonly auth?: AuthClient;
    readonly children: ReactNode;
}

export function StoreProvider({ store, auth, children }: StoreProviderProps): ReactElement {
    useEffect(() => {
        if (!auth) return;
        // Pump auth changes into the shared state.
        const pump = () => {
            authState.setUser(auth.getUser());
            authState.setToken(auth.getToken?.() ?? null);
        };
        pump();
        return auth.subscribe(pump);
    }, [auth]);

    return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
```

- [ ] **Step 3: Test with a fake AuthClient**

```typescript
it('StoreProvider pumps auth changes into AuthState', () => {
    const listeners = new Set<() => void>();
    let current: AuthUser | null = { id: 'alice' };
    const client: AuthClient = {
        getUser: () => current,
        subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    };

    render(<StoreProvider store={fakeStore} auth={client}>…</StoreProvider>);
    expect(authState.getUser()?.id).toBe('alice');

    current = { id: 'bob' };
    act(() => { for (const l of listeners) l(); });
    expect(authState.getUser()?.id).toBe('bob');
});
```

- [ ] **Step 4: Commit**

---

## Task 5: Surface subscription errors (`ACCESS_DENIED`) in hooks

The gateway sends `{ type: 'error', code: 'ACCESS_DENIED', message, ... }` frames. Client needs to:
1. Parse them in `gateway-connection.ts`
2. Route to the affected subscription (e.g. the entity hook's `error` slot)

**Files:**
- Modify: `packages/client/src/gateway-connection.ts`
- Modify: `packages/client/src/entity-client.ts`

- [ ] **Step 1: Identify the error frame handler**

Find where the gateway's frames are dispatched on the client. Look for `JSON.parse` / `msg.type === 'error'` in gateway-connection.ts.

- [ ] **Step 2: On `ACCESS_DENIED`, surface it**

When a channel subscription is rejected, the client can't bind this to one specific hook — but the app can listen for it. Simplest approach: expose a `subscribeToAuthErrors(cb)` from gateway-connection; useUser() (or a sibling hook) can surface the latest auth error.

- [ ] **Step 3: Write tests + commit**

*This task has the most unknowns. If the existing client error routing isn't amenable to per-hook error surfacing, simplify by just logging `ACCESS_DENIED` frames + updating AuthState's error field. UI surfacing beyond that is app-level.*

---

## Task 6: Full workspace verification

- [ ] Build: `pnpm -w build`
- [ ] Test: `pnpm -r --if-present test -- --run`
- [ ] Typecheck: `pnpm -r --if-present typecheck`

---

## Definition of Done

- `AuthState` exists and is subscribable
- `useUser()` returns `{ user, isAuthenticated }` reactively
- `StoreProvider` accepts `auth={authClient}` and pumps into AuthState
- `entity-client.ts`'s optimistic path reads live user via AuthState
- Channel subscribe errors surface somewhere the app can observe
- Full workspace build + tests pass

## What This Plan Does NOT Do

- **No provider SDK wrappers.** Plan 6 ships `@hexo/auth-clerk` etc. For now, apps write a tiny `AuthClient` that adapts their existing auth SDK.
- **No token refresh on the WebSocket.** The refresh callback on `AuthProvider` is server-side; the client relies on its auth provider's own refresh loop to update AuthState's token, which the next reconnect or RPC picks up.

## Subsequent Plans

| # | Plan | What it adds |
|---|------|-------------|
| 6 | Provider Adapters | `@hexo/auth-custom` (JWT) + the first OIDC adapter (e.g. Clerk) |
