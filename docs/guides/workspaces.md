# Workspaces Guide

> A workspace is a shared scope that groups tables, entities,
> topics, buses, and subscriber workflows into an isolated unit.
> Two browsers resolving to the same workspace see each other's
> state; different workspaces are fully isolated — different NATS
> subjects, different Restate virtual-object keys, zero cross-talk.

## The mental model

A workspace is **not a tenant**, not a team, not an account. It's just a scope. Your app decides what a workspace means:

| App type | Workspace maps to |
|---|---|
| Multi-user Figma-clone | Document / canvas |
| Slack-like chat | Room / channel |
| SaaS CRM | Organization |
| Single-player game | User id |
| Collaborative notebook | Notebook id |

The framework doesn't care. It just routes and isolates.

## Resolution

Every HTML and WebSocket request hits your `workspaces.resolve` in `syncengine.config.ts`. Return a string — the framework hashes it to a stable `wsKey` and uses the hash everywhere on the wire.

```ts
// syncengine.config.ts
export default config({
  workspaces: {
    resolve: ({ request }) => {
      const url = new URL(request.url);
      return url.searchParams.get('ws') ?? 'default';
    },
  },
});
```

Clients see the hash as a meta tag injected into the HTML:

```html
<meta name="syncengine-workspace-id" content="2bd806c97f0e00af">
```

That meta tag gates everything the client library does — WebSocket connect, RPC calls, channel subscription.

## What gets scoped

- **Tables** → CRDT rows live under `ws.<wsKey>.ch.<channelName>.deltas`
- **Entities** → Restate virtual objects keyed `<wsKey>/<entityKey>`
- **Topics** → `ws.<wsKey>.topic.<topicName>.<scope>`
- **Buses** → `ws.<wsKey>.bus.<busName>`
- **Subscriber workflows** → `BusDispatcher` per `(workspace × subscriber)` pair

Everything is scoped. A write in workspace A literally cannot be seen by workspace B — it's not a filter, it's routing.

## Lifecycle

### Provision

The first request that resolves to a workspace triggers **provision**:

1. The framework invokes Restate's `workspace.provision(wsKey)` virtual object.
2. Provision is idempotent — subsequent requests for the same wsKey short-circuit to "already active".
3. Provision:
   - Creates the workspace's JetStream stream (`WS_<wsKey>` for subjects `ws.<wsKey>.>`)
   - Registers the workspace entity and seq counters
   - Broadcasts to `syncengine.workspaces` topic so `BusManager` spawns dispatchers for this workspace

You don't write the provision handler — it's framework-owned. Your code just resolves the workspace; the infrastructure appears.

### Active

Once provisioned, the workspace is live. Clients connect via WebSocket, subscribe to channels, call entity RPCs. Every operation routes through the `wsKey` prefix.

### Reset

Admin operation — wipes workspace state without deleting the workspace:

```bash
syncengine state reset --workspace <wsKey>
```

Useful for dev/staging; destructive.

### Teardown

Removing a workspace isn't a first-class primitive yet (see Phase 2b deferred items). If you need teardown, delete the JetStream stream and Restate keys manually.

## Multi-workspace in one browser

The client library lets you switch workspaces mid-session:

```tsx
import { useStore } from '@syncengine/client';

function WorkspaceSwitcher() {
  const s = useStore<DB>();
  return (
    <button onClick={() => s.setWorkspace('room-B')}>Switch to room-B</button>
  );
}
```

Under the hood: `setWorkspace` tears down the current WebSocket + channel subscriptions, provisions the new workspace if needed, and re-subscribes. State from the old workspace is discarded; the new workspace's state starts streaming in.

## Workspaces vs. users

**Separate concepts.** Users identify **who** you are. Workspaces are **where** you are. They're orthogonal:

```
?user=alice&ws=room-1    alice in room-1 (sees bob's cursors + shared state)
?user=bob&ws=room-1      bob in room-1 (same workspace, different identity)
?user=bob&ws=room-2      bob in room-2 (different workspace, isolated)
?user=alice              alice in 'default' workspace
```

Auth (the `auth.verify` config hook) runs first, populates `ctx.user`. The resolver then decides what workspace this user accesses.

## Per-workspace hooks

**Subscriber workflows** fire per-workspace automatically — the `BusManager` spawns one `BusDispatcher` per `(workspace × subscriber)` pair. Your workflow body doesn't need to know the workspace; it's implicit in `ctx.key`.

**Heartbeats** with `scope: 'workspace'` run independently per workspace. `ctx.scopeKey` is the workspace id.

**Tables** don't need workspace awareness in your code — emits from an entity handler are routed to the emitting entity's workspace automatically.

## Authority + read-your-writes

Every channel write gets an **authority seq** — a monotonically increasing per-channel counter. Clients can wait on a specific seq before reading to guarantee read-your-writes across the NATS + CRDT merge layer:

```ts
await s.waitForAuthority(catalog, expectedSeq);
const rows = s.useTable(products);
```

The framework handles this automatically for RPC → read flows on the same client. Explicit `waitForAuthority` is only needed if you cross clients.

## Security: per-workspace ACLs

NATS subject-level permissions scope access per workspace:

```
sub ws.room-1.>    ← allowed for users in room-1
sub ws.room-2.>    ← denied
```

See `packages/core/src/nats-acl.ts` for the `generateNatsPermissions` helper. Hook it into your NATS auth callout or static config file.

## Footguns

- **Workspace switching discards in-flight state.** If a user switches mid-write, the pending RPC may complete in the background but the UI won't see it. Surface switching as a deliberate UI action.
- **Resolve is sync, hot path.** No I/O. Cache any lookups in memory or upstream.
- **`wsKey` is a hash.** Logs and admin tools show the hash, not your pre-hash label. If you want readable workspace names in logs, pass stable strings into `resolve` and log them alongside the hash.
- **Provision is framework-owned.** Don't write your own `workspace.provision` handler — the framework's setup is idempotent and handles stream creation, broadcast, and heartbeat attachment. Adding your own logic usually goes in a heartbeat with `trigger: 'boot'` instead.
- **Single workspace per connection.** A client is always in exactly one workspace. Multi-workspace dashboards need per-workspace clients.

## Links

- Config resolver: `packages/core/src/config.ts`, `packages/http-core/src/resolve.ts`
- Workspace entity: `packages/server/src/workspace/workspace.ts`
- Provision pipeline: `packages/http-core/src/provision.ts`
- ACL helper: `packages/core/src/nats-acl.ts`
