# Config Guide — `syncengine.config.ts`

> One file at the root of your app that tells the framework how to
> resolve workspaces, authenticate users, and swap services or buses
> for tests. Exports a typed `config({...})` call.

## Minimal example

```ts
// syncengine.config.ts
import { config } from '@syncengine/core';

export default config({
  workspaces: {
    resolve: ({ request }) => {
      const url = new URL(request.url);
      return url.searchParams.get('ws') ?? 'default';
    },
  },
});
```

That's enough to run. Browsers opening `?ws=room-1` get workspace `room-1`; omitting the param gives `'default'`.

## The full shape

```ts
config({
  workspaces: {
    resolve: (ctx) => string,                       // required
  },
  auth?: {
    verify: (ctx) => Promise<SyncengineUser | null>,  // optional
  },
  services?: {
    overrides: () => Promise<{ default: readonly ServiceOverride[] | ServiceOverride }>,
  },
});
```

Every field except `workspaces.resolve` is optional. Defaults are sensible: no auth, no overrides.

## `workspaces.resolve`

Called on every HTML and WebSocket request. Return the workspace id this request belongs to. The framework hashes the string to a stable `wsKey` and uses it everywhere:

- NATS subject prefix: `ws.<wsKey>.*`
- Restate virtual-object key prefix: `<wsKey>/...`
- HTML meta-tag injection: `<meta name="syncengine-workspace-id" content="<wsKey>">`

### Resolve context

```ts
interface WorkspaceResolveContext {
  readonly request: Request;      // incoming HTTP request
  readonly user: SyncengineUser | null;  // resolved by auth.verify (if configured)
  readonly url: URL;              // pre-parsed
}
```

### Patterns

**Per-URL-param (Meteor-style):**
```ts
resolve: ({ url }) => url.searchParams.get('ws') ?? 'default',
```

**Per-user (single-player):**
```ts
resolve: ({ user }) => user?.id ?? 'anonymous',
```

**Per-subdomain (SaaS):**
```ts
resolve: ({ url }) => url.hostname.split('.')[0],
```

**Per-cookie / JWT claim:**
```ts
resolve: ({ request }) => {
  const claims = jwtDecode(request.headers.get('cookie')?.match(/jwt=([^;]+)/)?.[1] ?? '');
  return claims.workspace_id;
},
```

### What the workspace bounds

Tables, entities, topics, and buses are all scoped to the resolved workspace. A row written in `room-A` never leaks into `room-B`. Two browsers with different resolves hit different NATS subjects and different Restate keys — complete isolation, no query-time filtering.

See `docs/guides/workspaces.md` for lifecycle details.

## `auth.verify`

Optional. Runs before `workspaces.resolve` if present — populates `ctx.user`.

```ts
auth: {
  verify: async ({ request }) => {
    const token = request.headers.get('authorization')?.slice(7);
    if (!token) return null;
    const claims = await verifyJwt(token);
    return { id: claims.sub, email: claims.email };
  },
},
```

Return `null` to reject (401 response). Return a `SyncengineUser` to accept. The framework then calls `workspaces.resolve({ user, request, url })` and proceeds.

## `services.overrides`

Swap service implementations at boot. Typical use: load stubs when `NODE_ENV === 'test'`:

```ts
// syncengine.config.ts
services: {
  overrides: process.env.NODE_ENV === 'test'
    ? () => import('./services/test')
    : undefined,
},
```

```ts
// src/services/test/index.ts
import { override } from '@syncengine/core';
import { payments } from '../payments';
import { notifications } from '../notifications';

export default [
  override(payments, {
    async charge(_amount: number) { return { id: 'ch_test' } as never; },
  }),
  override(notifications, {
    async send(msg: string) { console.log('[test-notif]', msg); },
  }),
];
```

The import is lazy — production boots without loading test code.

## Typed via `config()`

The exported helper is purely for type inference:

```ts
export function config<const T extends SyncengineConfig>(cfg: T): T;
```

It returns the object unchanged. The `const T` preserves literal types so the framework can type-check your config structure at authoring time. An alias `defineConfig` exists for Vite-style naming parity.

## Footguns

- **`workspaces.resolve` is called synchronously during request handling.** No I/O. If you need a DB lookup, cache it in memory and refresh out-of-band.
- **Workspace IDs become NATS subject components.** They must match `/^[a-zA-Z0-9_-]+$/` after the framework hashes them — the hash handles arbitrary input but logs can become unreadable if the pre-hash string is opaque.
- **`services.overrides` is a lazy import.** The module is only loaded when the function is called. If your overrides import anything that does side effects at load time (e.g. opens a DB connection), those side effects only fire once the framework resolves the overrides.
- **Single config export.** The framework imports `default` from `syncengine.config.ts`. Named exports are ignored; `export default config({...})` is the only supported shape.

## Links

- Type definitions: `packages/core/src/config.ts`
- Resolution pipeline: `packages/http-core/src/resolve.ts`
- Workspace lifecycle: `docs/guides/workspaces.md`
