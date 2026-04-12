# Syncengine DevTools v2 — Bottom Drawer Redesign

**Date:** 2026-04-14
**Status:** Draft

## Problem

The current devtools are a 360px floating popover that shows NATS plumbing internals (stream seq numbers, byte counts) and view row counts — but never actual data. Developers can't browse table contents, see view outputs, understand server vs client state divergence, or trace mutations through the pipeline. The devtools are "arcane" — they expose implementation details instead of helping developers build a mental model of their sync engine.

## Design Decisions

- **Bottom drawer** (Chrome DevTools model) — full viewport width for table grids
- **Template literals** for rendering — no framework, no createElement soup
- **Progressive disclosure** — glance (sync dots) → inspect (table rows) → trace (mutation timeline)
- **Client-side SQLite queries** — the worker has the actual client state; devtools query it via BroadcastChannel
- **Server metadata, not server data** — v1 shows server seq/msg counts from NATS monitor + Restate admin API, not full row-level server-side diffing

## Architecture

### Components

```
┌─────────────────────────────────────────────────┐
│  User's App (pushed up by drawer height)        │
├══════════════════ resize handle ═════════════════┤
│  Tab Bar: [Data] [Timeline] [State] [Actions]   │  ← always-visible status on right
├─────────────────────────────────────────────────┤
│  Tab Content (full width, scrollable)            │
└─────────────────────────────────────────────────┘
```

**Pill** — unchanged. Status dot (green/yellow/red) + "syncengine" label. Draggable. Click toggles drawer. Keyboard shortcut Ctrl+Shift+D.

**Drawer** — fixed to viewport bottom. Resizable via drag handle (height persisted to sessionStorage). Shadow DOM isolates styles. Default height: 280px. Min: 150px. Max: 60vh.

### Files

| File | Role |
|------|------|
| `devtools-client.js` | Rewrite — pill + drawer shell + tab routing + rendering + query protocol |
| `devtools-styles.css` | Rewrite — drawer layout, tabs, data grid, timeline |
| `devtools-plugin.ts` | Minor — no new endpoints (queries go via BroadcastChannel, not HTTP) |
| `data-worker.js` | Extend — handle `devtools-query` messages, enrich `devtools-status` with schema info and offline queue details, emit view recomputation events for timeline |

### Data Flow

```
                    BroadcastChannel
devtools-client.js ←──────────────→ data-worker.js
    │                                    │
    │  devtools-status (periodic)        │  client SQLite (tables, views)
    │  devtools-message (per mutation)   │  DBSP pipeline state
    │  devtools-query → query-result     │  offline queue, undo stack
    │                                    │
    ├── GET /__syncengine/devtools/metrics
    │       → NATS stream stats (msg count, bytes)
    │       → Workspace state (from Restate admin SQL)
    │       → Restate health
```

**New: `devtools-query` protocol** — the devtools client sends `{ type: 'devtools-query', id: <uuid>, sql: 'SELECT * FROM products' }` via BroadcastChannel. The worker executes it against client SQLite and replies with `{ type: 'devtools-query-result', id: <uuid>, columns: [...], rows: [...] }`. Query IDs prevent response mismatching.

## Tab Specifications

### 1. Data Tab

The primary tab. Two-pane layout: left sidebar (table/view picker) + right content (data grid).

**Left Sidebar (160px)**

Lists all tables and views from the schema, grouped under "Tables" and "Views" headings.

Each table shows a sync status indicator:
- **Green dot + "synced"** — client seq matches server stream last_seq (from NATS monitor). No items in offline queue for this table.
- **Yellow dot + "N pending"** — items in the offline queue targeting this table's channel. Local writes not yet confirmed by server.
- **Red dot + "error"** — connection lost or Restate unhealthy.

Views don't have sync indicators (they're derived from tables).

Clicking a table/view selects it and loads its data in the grid.

**Data Grid (right pane)**

Toolbar:
- Table/view name (bold)
- Row count
- Sync badge (SYNCED / N PENDING / BEHIND)
- `client seq: N · server seq: M` — shows divergence at a glance. If M > client seq, the client is behind.

Grid:
- Column headers from table schema (or view output columns)
- Rows from `SELECT * FROM <table> LIMIT 200` via the devtools-query protocol
- Rows with local-only writes (in offline queue) highlighted with a yellow left border and "local" indicator
- Monospace font for values, right-aligned numbers
- Click a row to expand it as JSON (for long text values or debugging)

**Identifying local-only rows**: The worker knows which deltas are in the `causalQueue` (offline queue). The devtools-status message must be extended to include offline queue entries (table name + row ID pairs). The devtools client cross-references these against displayed rows to apply the yellow highlight.

**Schema info in devtools-status**: The devtools-status message must be extended to include `tables: [{ name, columns: [{ name, type }] }]` and `views: [{ name, sourceTable }]` so the sidebar can list them without a separate query. This is sent once on initial ping response and re-sent if the schema changes (fingerprint mismatch).

### 2. Timeline Tab

Replaces the raw message log. Shows a vertical event stream, newest first.

Each event is a single line with:
- **Timestamp** — relative (2s, 1m) or absolute on hover
- **Badge** — color-coded by kind: `DELTA` (indigo), `ENTITY` (green), `AUTHORITY` (purple), `GC` (red), `TOPIC` (yellow)
- **Summary** — human-readable: `INSERT → transactions {productSlug: "keyboard", amount: 129}`
- **Pipeline trace** (collapsed by default) — expandable to show downstream effects: which views were recomputed, row count changes. Requires extending the worker's `broadcastDevtoolsMessage` to include a `affectedViews: string[]` field when a delta triggers view recomputation (the worker already knows this in `processDeltas`).

Filter buttons across the top (same kinds as today). Pause/resume button. "Clear" button to reset the log.

Max 100 entries in the ring buffer (up from 50).

### 3. State Tab

Compact operational dashboard. No sub-navigation — just a flat list of key-value rows grouped under headings.

**Connection**
- Status: live / connecting / disconnected / error (with colored badge)
- HLC: timestamp.counter (drift: <1s)
- Transport: gateway-ws / raw-nats

**Schema**
- Version: v1
- Fingerprint: abc123... (copyable)

**Workspace**
- ID: 37a8eec1 (copyable)
- Status: active / provisioning / deleted
- Members: N
- Restate: healthy / unhealthy

**Sync**
- Phase: ready / replaying / snapshot-loading
- Progress bar (during replay)
- Offline queue: N pending
- Undo depth: N

**Stream** (from NATS monitor)
- Messages: N
- Size: X KB
- Consumers: N

### 4. Actions Tab

Full-width button grid with descriptions. No grouping labels — color communicates severity.

| Button | Color | Description |
|--------|-------|-------------|
| Force Reconnect | default | Drop and re-establish the NATS connection |
| Trigger GC | default | Run garbage collection on the workspace stream |
| Clear Client DB | yellow | Wipe local SQLite/OPFS and reload |
| Purge Stream | yellow | Delete all messages from the NATS stream |
| Teardown Workspace | red | Delete workspace and its stream |
| Reset Everything | red | Teardown + clear all entity state + re-provision + clear client DB |

Each button has the action label (bold) and description (muted) side by side. Red buttons require a confirm dialog. Reset and Teardown fire the parallel client/server pattern (OPFS clear + server call simultaneously).

## Rendering Approach

**Template literals** — each tab has a `renderTabName()` function that returns an HTML string. The drawer shell calls the active tab's renderer and sets the tab content pane. The shadow DOM prevents style/script leakage.

**Event delegation** — instead of attaching listeners to each element, use a single `click` handler on the drawer that inspects `e.target.closest('[data-action]')` for action buttons and `e.target.closest('[data-table]')` for table selection. This survives template replacements without re-binding.

**Re-render strategy** — `render()` is called on:
- BroadcastChannel `devtools-status` messages (throttled to 1/sec max via requestAnimationFrame)
- Tab switches
- Table/view selection changes
- Query results arriving

Only the tab content pane re-renders — the tab bar, status indicators, and drawer shell are stable DOM.

## What's NOT in v1

- **Row-level server/client diffing** — requires replaying the NATS stream server-side into a parallel SQLite or building a snapshot comparison protocol. Deferred to v2.
- **SQL console** — free-form query input against client SQLite. Easy to add later since the devtools-query protocol already supports arbitrary SQL.
- **Entity actor state inspection** — would need new Restate admin API queries. Deferred.
- **Time-travel debugging** — replaying to a specific seq. Deferred.
- **Export/import** — dumping table data as JSON/CSV. Low priority.
