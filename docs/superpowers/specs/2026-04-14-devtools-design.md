# Syncengine DevTools — Design Spec

**Date:** 2026-04-14
**Status:** Draft

## Overview

A Meteor-style floating developer tools popover for syncengine local development. Zero-config: the vite plugin injects it automatically in dev mode, completely absent in production builds. Shows at-a-glance stack health, deep inspection of sync state / data / messages, and quick actions for common dev operations (clear DB, purge streams, reset workspace).

## Architecture

### Injection

The `syncengine()` vite plugin adds a `devtoolsPlugin` sub-plugin that:

1. In dev mode, injects a `<script type="module">` tag into served HTML that loads the devtools client
2. Adds two middleware endpoints under `/__syncengine/devtools/`
3. In production builds, does nothing — completely tree-shaken

### File Structure

```
packages/vite-plugin/src/devtools/
  devtools-plugin.ts     # Vite sub-plugin: HTML injection + metrics/action middleware
  devtools-client.js     # Self-contained browser script (injected into page)
  devtools-styles.css    # Shadow DOM styles (embedded into client.js at build time or inlined)
```

No new package. Lives inside the vite plugin since it is purely a dev-time concern.

### Rendering

The devtools client renders into a **shadow DOM** root appended to `<body>`. This isolates it from the app's styles and prevents any CSS interference in either direction. The script is vanilla JS — no React dependency — to avoid version conflicts and keep the footprint minimal.

### Communication

**Client ← Worker:** `BroadcastChannel('syncengine-devtools')`. The data worker broadcasts a status summary on every state change plus a 2-second heartbeat. The devtools script listens on this channel independently — no reference to the worker instance needed.

**Client ← Server:** `fetch('/__syncengine/devtools/metrics')` polled every 3 seconds. Returns aggregated NATS, Restate, and workspace state.

**Client → Server:** `fetch('/__syncengine/devtools/action', { method: 'POST' })` for executing actions (purge stream, trigger GC, etc.).

**Client ← Gateway:** Taps the existing gateway WebSocket connection for the live message log. The worker forwards message summaries on the BroadcastChannel.

## UI: The Pill (Collapsed State)

A small floating badge positioned bottom-right by default.

- **Size:** ~120px wide, 28px tall, `border-radius: 14px`
- **Content:** Status dot (12px circle) + `syncengine` label
- **Background:** Semi-transparent dark (`rgba(9, 9, 11, 0.9)`), subtle border
- **Status dot colors:**
  - **Green** — gateway connected, sync phase is `live`
  - **Yellow** — connecting, replaying, or reconnecting
  - **Red** — disconnected or error
- **Conflict badge:** When conflicts > 0, show count: `● syncengine ⚠2`
- **Interaction:**
  - Click or `Ctrl+Shift+D` → expand popover
  - Draggable to reposition (position persisted in `sessionStorage`)
  - Right-click → context menu with quick actions (force reconnect, reset client DB)

## UI: The Popover (Expanded State)

Floating card anchored to the pill's position.

- **Size:** ~360px wide, max-height 70vh, scrollable
- **Background:** Dark card (`#18181b`), border (`#27272a`), `border-radius: 8px`, drop shadow
- **Navigation:** Five accordion sections, all collapsed by default. Click header to toggle. Multiple can be open simultaneously. Expand/collapse state persisted in `sessionStorage`.
- **Header bar:** `Syncengine DevTools` label + minimize button (collapses back to pill)

### Section 1: Sync & Connection

| Field | Source | Description |
|-------|--------|-------------|
| Connection status | Worker broadcast | Badge: `connected` / `connecting` / `error` |
| Sync phase | Worker broadcast | `idle` → `replaying` → `live`, progress bar during replay |
| Messages replayed | Worker broadcast | `450 / 450` with progress bar |
| Snapshot loaded | Worker broadcast | Boolean indicator |
| HLC clock | Worker broadcast | Current timestamp + counter, drift from wall clock |
| Schema version | Worker broadcast | Version number + fingerprint |
| Offline queue | Worker broadcast | Count of queued mutations, shown only when > 0 |
| Workspace ID | Runtime config | Truncated, click to copy full ID |
| Gateway URL | Runtime config | WebSocket URL |
| Latency | Worker broadcast | Time since last message received |

### Section 2: Data

**Channels** (from server metrics):
- Per channel: name, message count, last seq, byte size

**Views** (from worker broadcast):
- Per view: name, row count

**Entities** (from worker broadcast):
- Per subscription: entity name + key
- Confirmed vs optimistic diff indicator
- Pending action count
- Click to expand: full confirmed state JSON + optimistic state JSON side by side

**Conflicts** (from worker broadcast):
- List of unresolved merge conflicts
- Each: table, field, winner/loser values, HLC timestamps, resolution strategy
- Dismiss button per conflict

**Undo Stack** (from worker broadcast):
- Current depth (e.g., `Undo: 2 actions`)

### Section 3: Message Log

Live scrolling list of recent messages (last ~50, ring buffer).

- Each row: relative timestamp, type badge (`delta` / `entity-write` / `entity-state` / `topic` / `gc` / `authority`), channel/entity name, payload preview (truncated)
- Click row → expand full JSON payload
- Filter toggles by message type (top of section)
- Pause / Resume button (pauses the scroll, still buffers)
- Auto-scrolls when not paused and scrolled to bottom

### Section 4: Peers

| Field | Source | Description |
|-------|--------|-------------|
| Workspace members | Server metrics | List of client IDs from `listMembers` |
| Consumer count | Server metrics (NATS) | Number of JetStream consumers |
| Topic peers | Worker broadcast | Active topic subscriptions (e.g., cursor/presence peers) |

### Section 5: Actions

**Safe (single click, immediate):**
- **Force Reconnect** — drops gateway WebSocket, worker re-establishes. Toast on success.
- **Trigger GC** — POST to action endpoint → calls `triggerGC` on workspace. Shows purged message count in toast.

**Moderate (single click, with visual feedback):**
- **Clear Client DB** — wipes OPFS SQLite, triggers full re-sync from server. Toast: "Client DB cleared, re-syncing..."
- **Purge Stream** — POST to action endpoint → calls NATS admin API to purge the workspace JetStream stream. Toast: "Stream purged, {n} messages removed"

**Destructive (confirmation dialog required):**
- **Teardown Workspace** — red button → confirmation dialog ("This will delete all workspace state. Continue?") → POST to action endpoint → calls `teardown` then `provision`. Toast on completion.
- **Reset Everything** — red button → confirmation dialog ("This will clear client DB, purge stream, and teardown workspace. Continue?") → orchestrates: clear DB + purge stream + teardown + re-provision. Toast on completion.

All actions show a brief toast/flash overlay anchored to the popover: green for success, red for error, with the response message.

## Server: Metrics Endpoint

`GET /__syncengine/devtools/metrics`

Response:
```json
{
  "nats": {
    "streams": [{
      "name": "WS_37a8eec1...",
      "messages": 12345,
      "bytes": 98765,
      "firstSeq": 100,
      "lastSeq": 12345,
      "consumerCount": 3
    }]
  },
  "restate": {
    "healthy": true,
    "services": ["workspace", "entity_inventory", "entity_order", "workflow_checkout"]
  },
  "workspace": {
    "id": "37a8eec1...",
    "active": true,
    "members": ["client-a1b2", "client-c3d4"],
    "schemaVersion": 3
  }
}
```

**Data sources:**
- **NATS:** Fetches `http://127.0.0.1:{natsMonitor}/jsz?streams=true` and extracts workspace stream stats
- **Restate:** Fetches `http://127.0.0.1:{restateAdmin}/health` for service list and health
- **Workspace:** Calls `getState` + `listMembers` on the Restate ingress (`http://127.0.0.1:{restateIngress}/workspace/{workspaceId}/getState` and `.../listMembers`)

URLs are read from `.syncengine/dev/runtime.json` (already available to the vite plugin).

## Server: Action Endpoint

`POST /__syncengine/devtools/action`

Request body:
```json
{ "action": "force-reconnect" | "clear-client-db" | "purge-stream" | "trigger-gc" | "teardown" | "reset" }
```

Response: `{ "ok": true, "message": "..." }` or `{ "ok": false, "error": "..." }`

**Action implementations:**
- `purge-stream`: Connects to NATS, calls `jsm.streams.purge(streamName)`
- `trigger-gc`: POST to Restate ingress `workspace/{id}/triggerGC`
- `teardown`: POST to Restate ingress `workspace/{id}/teardown`
- `reset`: Orchestrates purge-stream + teardown + re-provision (POST `workspace/{id}/provision`)
- `force-reconnect` and `clear-client-db`: Handled client-side only (no server POST needed). The action endpoint returns `{ "ok": true, "message": "client-only" }` as a no-op so the client code path stays uniform.

## Worker: BroadcastChannel Protocol

Channel name: `syncengine-devtools`

The data worker broadcasts on every status change, plus a 2-second heartbeat:

```json
{
  "type": "devtools-status",
  "sync": {
    "phase": "live",
    "messagesReplayed": 450,
    "totalMessages": 450,
    "snapshotLoaded": true
  },
  "connection": "synced",
  "hlc": { "ts": 1713091200000, "counter": 3 },
  "conflicts": [
    { "table": "orders", "field": "status", "winner": "shipped", "loser": "pending", "strategy": "last-write-wins" }
  ],
  "offlineQueue": 0,
  "undoDepth": 2,
  "schema": { "version": 3, "fingerprint": "a1b2c3d4" },
  "entities": [
    { "name": "inventory", "key": "headphones", "pending": 1, "hasDiff": true }
  ],
  "channels": ["catalog", "ledger"],
  "views": { "catalog": 24, "ledger": 156 }
}
```

For the message log, the worker broadcasts individual messages:
```json
{
  "type": "devtools-message",
  "ts": 1713091200123,
  "kind": "delta",
  "channel": "catalog",
  "seq": 1234,
  "payload": { ... }
}
```

**Cost:** One extra `JSON.stringify` per status change + per 2s heartbeat. Negligible relative to the DBSP pipeline work already happening. The BroadcastChannel is only created if a listener exists (devtools script sets a flag via a `devtools-ping` message on channel creation; worker only broadcasts if it has received a ping).

## Styling

Reuses the test app's CSS variable palette for visual consistency:

```css
--dt-bg: #09090b;
--dt-bg-card: #18181b;
--dt-border: #27272a;
--dt-fg: #fafafa;
--dt-muted: #71717a;
--dt-accent: #6366f1;
--dt-green: #22c55e;
--dt-yellow: #eab308;
--dt-red: #ef4444;
--dt-radius: 8px;
--dt-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
```

All styles scoped inside the shadow DOM. Font sizes: 12px body, 11px for data tables and message log. Transitions: 150ms ease for accordion expand/collapse and popover open/close.
