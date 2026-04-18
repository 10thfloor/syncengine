# Auth Design — Hexo Framework

> Three-layer auth model with typed access policies, `$user` as a framework primitive, and pluggable auth providers.

## Core Principle

Auth is not a new ring in the onion — it's a cross-cutting concern that threads through three existing boundaries: **workspace**, **channel**, and **entity**. Views don't need auth; channel access controls which views you can subscribe to.

## The Three Layers

| Layer | Controls | When checked |
|-------|----------|-------------|
| **Workspace** | Who can connect | WebSocket handshake |
| **Channel** | What data reaches the device | Subscription time |
| **Entity** | Who can call which handlers | Before handler dispatch |

## 1. Auth Provider — Hexagonal Adapter

Authentication is delegated to external providers via a port/adapter pattern. The framework owns authorization; providers own identity verification.

```ts
// syncengine.config.ts
import { config } from 'hexo';
import { clerk } from '@hexo/auth-clerk';

export default config({
  auth: {
    provider: clerk({ publishableKey: '...' }),
    // or: auth0({ domain: '...', clientId: '...' }),
    // or: custom({ verify: async (token) => ... }),
  },
  workspaces: { ... },
});
```

### Provider Port Interface

```ts
interface AuthProvider {
  verify(token: string): Promise<AuthUser>;
  refresh?(token: string): Promise<string>;
}

interface AuthUser {
  id: string;
  email?: string;
  claims: Record<string, unknown>;
}
```

Any provider that implements this interface is a valid adapter. First-party adapters: `@hexo/auth-clerk`, `@hexo/auth-auth0`, `@hexo/auth-custom`.

## 2. `$user` — Framework-Resolved Primitive

Like `$key` resolves to the entity's key, `$user` resolves to the authenticated user's ID. Handlers stay pure — `$user` is a declarative placeholder, not a context lookup.

```ts
sell(state, price: Money.T, now: number) {
  return emit({
    state: { ...state, stock: state.stock - 1 },
    effects: [
      insert(transactions, {
        productSlug: '$key',
        userId:      '$user',   // resolved by runtime
        amount: price,
      }),
    ],
  });
}
```

### Resolution Context

| Context | `$user` resolves from |
|---------|----------------------|
| Server (entity runtime) | Verified identity on the connection |
| Client (optimistic) | Local `useUser()` state from auth provider SDK |
| Workflow (system) | System identity (no user) — `$user` is `'$system'` |

### Audit Trail

`$user` in emit effects means every row automatically records who created it. Audit logging is free.

## 3. Workspace Access

Checked on WebSocket handshake. Uses the existing workspace membership model (already stored in Restate state as `Keys.MEMBERS`).

```ts
export default config({
  workspaces: {
    resolve: ({ request }) => {
      const url = new URL(request.url);
      return url.searchParams.get('ws') ?? 'default';
    },
  },
});
```

Membership is checked against the workspace's member list. If the authenticated user is not a member, the connection is rejected.

### Per-User Workspaces

For apps requiring hard per-user isolation (user A must never see user B's data, even on-device), each user gets their own workspace. Workspaces are cheap — this is the supported escape hatch.

## 4. Channel Access

Checked at subscription time. Controls which tables and views reach the client's device.

```ts
export const shopChannel = channel('shop', [products]);

export const ledgerChannel = channel('ledger', [transactions], {
  access: (user) => user.role !== 'viewer',
});

export const adminChannel = channel('admin', [allOrders], {
  access: (user) => Access.role(Role, 'admin').check(user),
});
```

No `access` predicate = public within the workspace (any authenticated workspace member can subscribe).

### Data Classification

Data that must not reach the client device (PII, regulated data) should be kept off client-synced channels entirely. Serve it via entity `_read` calls or traditional API endpoints.

## 5. Entity Access — Typed Policies

Evaluated before handler dispatch. If the policy rejects, the handler never runs. On the client, the optimistic state rebases (permission denied rebase).

### Role Value Object

Roles are defined as a value object — typos are compile errors.

```ts
import { defineValue, text } from 'hexo';

export const Role = defineValue('role',
  text({ enum: ['owner', 'admin', 'member', 'viewer'] as const }),
);
```

### Access API

```ts
import { Access } from 'hexo';

export const inventory = entity('inventory', {
  state: { ... },
  transitions: { ... },

  access: {
    _read:   Access.public,
    restock: Access.role(Role, 'admin'),
    sell:    Access.any(
               Access.role(Role, 'member'),
               Access.role(Role, 'admin'),
             ),
    cancel:  Access.all(
               Access.authenticated,
               Access.owner(),
             ),
    '*':     Access.deny,
  },

  handlers: { ... },
});
```

### Access Primitives

| Primitive | Meaning |
|-----------|---------|
| `Access.public` | Anyone, including unauthenticated |
| `Access.authenticated` | Must be logged in |
| `Access.deny` | Explicitly forbidden |
| `Access.role(ValueObj, ...roles)` | User's role (per-workspace) matches one of the listed roles. Type-checked against the value object's enum. |
| `Access.owner()` | Entity state has a field matching `$user` (convention: `userId` or `ownerId`) |
| `Access.any(...policies)` | At least one policy passes |
| `Access.all(...policies)` | All policies must pass |
| `Access.where((user, key) => bool)` | Custom predicate escape hatch. Receives the authenticated user and entity key. |
| `'*'` | Default policy for unlisted handlers |

### Access Denied on the Client

When the server rejects a handler call, the client's optimistic state rebases and the action throws:

```ts
try {
  await actions.restock(100);
} catch (e) {
  // AccessDeniedError — optimistic state rolled back
}
```

## 6. Workflow Identity

Workflows are system processes triggered by bus events. They bypass entity access policies — the bus subscription IS their authorization. The chain is: authorized handler → publish → bus → workflow → entity call. Trust is transitive.

When a workflow calls an entity handler, `$user` resolves to `'$system'`. This is visible in the audit trail.

## 7. Client — `useUser()` Hook

The framework provides a reactive hook backed by the auth provider's client SDK:

```ts
const { user, isLoading, signIn, signOut } = useUser();
// user.id, user.email, user.role (per-workspace)
```

Works regardless of which provider adapter is configured. The hook is the client-side counterpart to `$user` on the server.

## 8. Token Lifecycle

- **Handshake**: Client sends JWT in WebSocket upgrade. Server verifies via provider adapter.
- **Refresh**: Auth provider SDK handles token refresh on the client. Framework re-verifies on the existing connection without dropping it.
- **Reconnect**: After offline, re-verify before replaying queued optimistic actions. If auth fails (token expired, user removed from workspace), queued actions are discarded and state rebases.
- **Revocation**: If a user is removed from a workspace while connected, the server closes the WebSocket and the client receives a `WORKSPACE_ACCESS_REVOKED` event.

## Tradeoffs — Acknowledged

| Tradeoff | Accepted because |
|----------|-----------------|
| No per-row security within a channel | Channel access is the security boundary. Per-user data filtering is a UI concern, not a security concern. For hard isolation, use per-user workspaces. |
| Data on-device for subscribed channels | Regulated data stays off client-synced channels. Served via server-only entity reads or API endpoints. |
| Channel granularity = data granularity | Split sensitive columns into separate tables in separate channels. Better data modeling. |
| Workflows bypass access policies | Bus subscription is the authorization. Trust is transitive from the original authorized handler. |

## Scaffolding

```bash
$ hexo add auth --provider clerk
```

Generates:
- `src/auth.ts` — provider config, Role value object
- Updates `syncengine.config.ts` with auth block
- Installs `@hexo/auth-clerk` adapter
- Adds `useUser()` to client store

## Non-Goals (v1)

- **Row-level security on views** — deferred. Channel access is sufficient for v1.
- **Server-filtered channels** — deferred. If needed, add as opt-in `scope('server')` later.
- **Multi-provider** — one provider per app. If needed, compose at the provider adapter level.
- **Permission management UI** — out of scope. Workspace membership is managed via the provider's dashboard or a custom admin entity.
