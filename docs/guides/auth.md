# Auth Guide

> Three-layer authorization (workspace → channel → entity) backed by a
> pluggable `AuthProvider` port. `Access` DSL for policies. `useUser()`
> and `useAuthError()` on the client. Spec:
> `docs/superpowers/specs/2026-04-21-auth-design.md`.

## Mental model

| Layer | Gate | Enforcement site |
|---|---|---|
| **Workspace** | Membership | WebSocket handshake + entity RPC |
| **Channel** | `access` predicate on `channel(..., { access })` | Gateway at `subscribe` time |
| **Entity** | `access` map on `entity({ ..., access })` | `applyHandler` on both client and server |

Anonymous callers (no token, or rejected token) get `user: null`. Only
`Access.public` policies accept them; every other policy fails closed.

## Server wiring

### 1. Pick an adapter

```ts
// syncengine.config.ts
import { config } from '@syncengine/core';
import { jwt, unverified, custom } from '@syncengine/server';

export default config({
    workspaces: { resolve: ({ request }) => 'default' },
    auth: {
        // ── Production: OIDC / JWT ─────────────────────────────
        provider: jwt({
            jwksUri: 'https://auth.example.com/.well-known/jwks.json',
            issuer: 'https://auth.example.com',
            audience: 'my-api',
        }),

        // ── Dev only: bearer token IS the user id ─────────────
        // provider: unverified(),

        // ── Custom: bring your own verify function ────────────
        // provider: custom({ verify: async (token) => ... }),
    },
});
```

### 2. Declare access policies

```ts
import { Access, entity, channel, text, integer, defineValue } from '@syncengine/core';

// Roles as a value object — compile-time checked
const Role = defineValue('role', text({
    enum: ['owner', 'admin', 'member', 'viewer'] as const,
}));

// Entity-level access
export const inventory = entity('inventory', {
    state: { stock: integer(), reserved: integer() },
    access: {
        restock: Access.role(Role, 'owner', 'admin'),
        sell:    Access.authenticated,
        cancel:  Access.all(Access.authenticated, Access.owner()),
        '*':     Access.deny,
    },
    handlers: { /* ... */ },
});

// Channel-level access
export const adminChannel = channel('admin', [auditLog], {
    access: Access.role(Role, 'admin'),
});
```

### 3. `$user` placeholder in emits

Capture who performed the action without threading user ids through
handler signatures:

```ts
sell(state, price: number, now: number) {
    return emit({
        state: { ...state, stock: state.stock - 1 },
        effects: [
            insert(transactions, {
                productSlug: '$key',
                userId:      '$user',   // resolved server-side
                amount: price,
                timestamp: now,
            }),
        ],
    });
}
```

The runtime substitutes `'$user'` with the authenticated user's id at
publish time, same lifecycle as `'$key'`.

## Client wiring

### 1. Write an `AuthClient` adapter

Any auth SDK — just three methods:

```ts
import type { AuthClient } from '@syncengine/client';

// Example: Clerk (@clerk/clerk-react)
import { useAuth, useUser as useClerkUser } from '@clerk/clerk-react';

export function useSyncengineAuth(): AuthClient {
    const clerk = useAuth();
    const { user } = useClerkUser();
    return {
        getUser: () => user ? { id: user.id, email: user.primaryEmailAddress?.emailAddress } : null,
        subscribe: (cb) => {
            // Clerk fires the callback we pass on state changes; most
            // SDKs expose something similar (listener or store.subscribe).
            return clerk.addListener(cb);
        },
        getToken: () => clerk.sessionId ? clerk.getToken() : null,
    };
}
```

### 2. Pass it to `StoreProvider`

```tsx
function Root() {
    const auth = useSyncengineAuth();
    return (
        <StoreProvider store={db} auth={auth}>
            <App />
        </StoreProvider>
    );
}
```

### 3. Read the user in any component

```tsx
import { useUser, useAuthError } from '@syncengine/client';

function Header() {
    const { user, isAuthenticated } = useUser();
    const error = useAuthError();

    if (error) return <Banner>{error.message}</Banner>;
    if (!isAuthenticated) return <SignInButton />;
    return <Avatar email={user!.email} />;
}
```

`useAuthError` surfaces `UNAUTHORIZED` (init rejection) and
`ACCESS_DENIED` (channel subscribe) frames from the gateway. Clear it
with `authState.setError(null)` when the user dismisses.

## Access DSL reference

| Primitive | Meaning |
|---|---|
| `Access.public` | Anyone, including `user: null` |
| `Access.authenticated` | `user !== null` |
| `Access.deny` | Always false |
| `Access.role(RoleDef, 'admin', ...)` | User's per-workspace role matches one of the listed roles (type-checked against the value-object enum) |
| `Access.role('admin', ...)` | Same, with bare-string roles |
| `Access.owner(field?)` | `state[field ?? 'userId'] === user.id` |
| `Access.any(...policies)` | Any of the policies passes |
| `Access.all(...policies)` | All of the policies pass |
| `Access.where((user, key) => bool)` | Custom predicate escape hatch |

## Known limitations

- **Token refresh on long-lived WebSocket** — the `AuthProvider.refresh`
  hook exists on the server port, but there is no built-in client-side
  refresh loop. Your frontend auth SDK's own refresh mechanism should
  call `authState.setToken(newToken)` or re-render with a fresh token.

## Further reading

- Spec: `docs/superpowers/specs/2026-04-21-auth-design.md`
- Implementation plans: `docs/superpowers/plans/2026-04-21-auth-*.md`,
  `2026-04-22-auth-*.md`
- Access DSL source: `packages/core/src/auth.ts`
- Provider adapters: `packages/server/src/auth/`
- Client: `packages/client/src/auth-state.ts`, `use-user.ts`
