# Reactive Workspace Primitive

**Date:** 2026-04-15
**Status:** Draft
**Scope:** Core framework feature — `@syncengine/client`, `@syncengine/core`

## Summary

Make the workspace a reactive primitive at the root of the sync engine's dependency graph. Today the workspace ID is a static compile-time value read once at worker init. This spec makes it a runtime-switchable actor identity: the worker owns the workspace, the main thread observes and requests changes, and all downstream state (SQLite, NATS, DBSP, views, topics, HLC) tears down and rebuilds automatically on switch.

## Goals

- Workspace switching as a first-class framework operation, not a page reload
- Actor model: worker is the authority, main thread sends commands and observes events
- Built with the framework's own reactive primitives (same message channel, same `useSyncExternalStore` pattern)
- App controls transition UX via lifecycle status signals
- Workspace-scoped persistence: switching back to a previous workspace resumes from persisted state

## Non-Goals

- Devtools workspace UI (separate future spec)
- Per-workspace schema differences (all workspaces share the same schema for now)
- Concurrent multi-workspace (only one active workspace per worker at a time)

## Architecture

### Actor Model

The worker is an actor. Its identity is the current workspace. All internal state is scoped to that identity. The main thread communicates exclusively via messages — it never touches workspace internals.

### Epoch Counter

The worker holds a monotonically increasing `epoch: number`. Every `SWITCH_WORKSPACE` increments it. Every async operation captures the epoch at its start and checks it before applying results:

```
const myEpoch = epoch;
const result = await someAsyncWork();
if (myEpoch !== epoch) return; // stale, discard
applyResult(result);
```

This applies to: NATS message handlers, JetStream consumer loops, gateway `onMessage`, SQLite async operations, fetch calls (provision, authority, peer ack).

### Superseding Commands

When `SWITCH_WORKSPACE` arrives while a previous switch is in-flight:

1. Increment epoch (invalidates all in-flight work from previous switch)
2. Best-effort teardown of current connections (close WebSocket, drain NATS — don't await)
3. Start fresh init for the new wsKey

No queue, no debounce. The latest command wins immediately.

## Protocol

### Command (Main → Worker)

```typescript
{ type: 'SWITCH_WORKSPACE', wsKey: string, requestId: string }
```

### Event (Worker → Main)

```typescript
{
  type: 'WORKSPACE_STATUS',
  wsKey: string,
  requestId: string,
  status: 'switching' | 'provisioning' | 'connecting' | 'replaying' | 'live' | 'error',
  error?: string
}
```

The `requestId` lets the store ignore stale status updates from a superseded switch. The store tracks `lastRequestId` and drops any `WORKSPACE_STATUS` whose `requestId` doesn't match.

### Status Lifecycle

```
live → switching → provisioning → connecting → replaying → live
                                                         ↘ error
```

- `switching` — emitted immediately, old workspace tearing down
- `provisioning` — SQLite opened for new workspace, loading persisted state
- `connecting` — establishing NATS/gateway connection
- `replaying` — JetStream consumers catching up from high-water marks
- `live` — fully synced, mutations enabled
- `error` — init failed, app can retry via `setWorkspace`

## Worker Lifecycle

### Teardown (Dispose Phase)

Runs under the new epoch. Steps are best-effort and non-blocking:

1. Close gateway WebSocket / NATS connection
2. Unsubscribe all topic subscriptions
3. Drain offline queue to old workspace (flush any buffered outbound messages on the still-open connection before closing — no reconnection if already closed)
4. Clear: DBSP engine state, view cache, undo stack, offline queue, nonce set, HLC, replay coordinator, authority state
5. Close SQLite handle
6. Close BroadcastChannel
7. Emit `{ status: 'switching' }`

### Init (Setup Phase)

Each step checks epoch before proceeding — if epoch has advanced, abort:

1. Open SQLite at `/syncengine-{wsKey}.sqlite3` → emit `{ status: 'provisioning' }`
2. Create tables, load high-water marks from `_dbsp_meta`
3. Open BroadcastChannel `syncengine-sync-{wsKey}`
4. Connect gateway/NATS → emit `{ status: 'connecting' }`
5. Create JetStream consumers, start replay → emit `{ status: 'replaying' }`
6. Finalize replay, hydrate DBSP from SQLite → emit `{ status: 'live' }`

If any step fails and epoch is still current: emit `{ status: 'error', error: message }`.

## Subsystem Changes

### SQLite

Path becomes workspace-scoped: `/syncengine-{wsKey}.sqlite3`. On switch, close handle, open new path. Switching back to a previous workspace resumes from persisted high-water marks (stored in per-file `_dbsp_meta` table). No full replay needed for previously-visited workspaces.

### NATS / Gateway

Close old connection, open new. Subject routing rebuilds from new wsKey (`ws.{wsKey}.ch.{channel}.deltas`, etc.). Stream name rebuilds via `streamName(wsKey)`. Gateway init handshake sends new wsKey. All consumer loops are epoch-guarded.

### DBSP Engine

`dbsp.reset()` clears materialized state. The engine is schema-bound, not workspace-bound, so it survives the switch. Re-hydrated from SQLite during the init phase.

### Authority / CALM

Unsubscribe old authority stream, reset sequence counters and backoff state, subscribe to new workspace's authority subject.

### Topics

The `desired` set (topic subscriptions the app has requested) survives the switch — it represents app intent, not workspace state. On reconnect, topics re-subscribe with new workspace-scoped subjects. Peer state (`topicPeers`) clears.

### HLC

Reset to zero on switch. New workspace is a new causal context.

### Undo Stack

Clear on switch. Undo history is meaningless across workspaces.

### Offline Queue

Drain to old workspace (best-effort publish before teardown), then clear. Mutations belong to the workspace they were made in.

### BroadcastChannel

Scoped per workspace: `syncengine-sync-{wsKey}`. On switch, close old channel, open new one. Tabs on different workspaces don't interfere.

## Public API

### Store (main thread, framework-agnostic)

```typescript
db.workspace       // readonly: { wsKey: string, status: WorkspaceStatus, error?: string }
db.setWorkspace(wsKey: string): void  // request a switch (fire-and-forget)
```

`setWorkspace` is fire-and-forget. The caller observes the transition via `db.workspace.status`. Same pattern as `db.emit()`.

If `wsKey === currentWsKey`, no-op.

### React Hook

```typescript
const { workspace, setWorkspace, ready, views, ... } = db.use({ ... })

// workspace: { wsKey: string, status: WorkspaceStatus, error?: string }
// setWorkspace: (wsKey: string) => void
```

Returned alongside `connection`, `sync`, `ready` in the existing `use()` result.

`ready` becomes workspace-aware: `true` only when `workspace.status === 'live'` AND views have been hydrated. During a switch, `ready` goes `false` and views return empty arrays.

### Store Internals

```typescript
// State
let currentWsKey: string = initialWsKey;
let lastRequestId: string | null = null;
let workspaceStatus: WorkspaceInfo = { wsKey: initialWsKey, status: 'live' };

// On setWorkspace(wsKey):
// 1. Guard: wsKey === currentWsKey → no-op
// 2. Generate requestId, store as lastRequestId
// 3. Post SWITCH_WORKSPACE to worker
// 4. Immediately set workspaceStatus to { wsKey, status: 'switching' }, notify subscribers

// On WORKSPACE_STATUS from worker:
// 1. Guard: msg.requestId !== lastRequestId → discard (superseded)
// 2. Update workspaceStatus, notify subscribers
// 3. If status === 'live': update currentWsKey, clear and re-request view snapshots
```

## Test App Affordance

A minimal workspace switcher in the existing test app to exercise the primitive without touching devtools:

- Text input + button in the app header: type a raw workspace ID, click "Switch"
- Calls `db.setWorkspace(hashWorkspaceId(inputValue))`
- Displays current `workspace.wsKey` (truncated) and `workspace.status` as a badge
- The `?user=` query param still sets the initial workspace via the vite middleware, but the switcher overrides it at runtime

## What Doesn't Change

- **Schema definition** (`schema.ts`) — workspace-independent
- **Entity actors** — workspace is server-side context via Restate virtual object key
- **View definitions** — same views materialize per workspace
- **Topic definitions** — subscriptions re-scope automatically via subject routing
- **Vite plugin workspace resolution** — still provides the initial wsKey via meta tags
- **Gateway server** — bridges are already per-workspace, no changes needed
- **Boot sequence** (`dev.ts`) — provisions default workspace at startup, unchanged

## File Inventory

Files that need changes:

| File | Change |
|------|--------|
| `packages/client/src/workers/data-worker.js` | Epoch counter, `SWITCH_WORKSPACE` handler, workspace-scoped SQLite path, workspace-scoped BroadcastChannel, epoch guards on all async callbacks |
| `packages/client/src/store.ts` | `workspace` signal, `setWorkspace()`, `WORKSPACE_STATUS` handler, `ready` redefinition |
| `packages/client/src/react.tsx` | Export `WorkspaceStatus` type (if not already in store) |
| `packages/client/src/gateway-connection.ts` | No changes needed (already receives wsKey per call) |
| `apps/test/src/App.tsx` | Workspace switcher UI affordance |
| `packages/core/src/http.ts` | No changes (hashWorkspaceId already exported) |
