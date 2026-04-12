# Error Boundaries — Framework Error Signals

**Date:** 2026-04-15
**Status:** Draft
**Scope:** `@syncengine/client` (store.ts, data-worker.js), test app UI

## Summary

Four error signals that the framework exposes but doesn't handle well today. All follow the existing pattern: reactive signals observed via `useSyncExternalStore`, rendered however the app decides. No React `ErrorBoundary` — syncengine errors are async, not render-time throws.

## Goals

- Worker crash detection with automatic recovery
- Auth failure carries actionable error detail
- Merge conflicts surfaced in the test app UI
- Authority staleness visible on affected views

## Non-Goals

- Custom error page framework (the app controls rendering)
- Retry UI components (the app decides how to retry)
- Error logging/telemetry (separate concern)

---

## 1. Worker Health Signal

### Problem

If the Web Worker terminates (WASM OOM, unhandled exception, browser kills it), the store freezes with stale data. No signal is emitted. The developer has no way to detect this.

### Design

The store monitors the worker via a heartbeat. The worker sends a `HEARTBEAT` message on a timer (every 5s). The store tracks the last heartbeat timestamp. If no heartbeat arrives within 15s, the store sets `workerStatus` to `'dead'` and notifies subscribers.

On detecting a dead worker:
1. Emit `workerStatus: 'dead'`
2. The store does NOT auto-recover — it exposes the signal and lets the app decide (show error, reload page, call `db.destroy()` + reinitialize)

This avoids hidden recovery logic that could mask data corruption.

**New signal on UseResult:**

```typescript
workerHealth: 'alive' | 'dead'
```

**Worker side:** Add a `setInterval` that posts `{ type: 'HEARTBEAT' }` every 5 seconds.

**Store side:** Track `lastHeartbeat = Date.now()` on each heartbeat. A `setInterval` checks every 5s: if `Date.now() - lastHeartbeat > 15_000`, set `workerHealth = 'dead'` and notify subscribers. Clear the interval in `destroy()`.

### Test App

Show a non-dismissible error banner when `workerHealth === 'dead'`:

```
Worker crashed — reload the page to reconnect.
```

---

## 2. Auth Error Detail

### Problem

When `connection === 'auth_failed'`, the developer gets a string enum but no error message. They can't tell the user what went wrong or how to fix it (expired token? wrong credentials? permission denied?).

### Design

Extend `ConnectionStatus` from a string union to a structured type:

```typescript
// Before
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'auth_failed';

// After
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

interface ConnectionInfo {
    status: ConnectionStatus | 'auth_failed' | 'error';
    error?: string;
}
```

Wait — this is a breaking change to the `connection` field in `UseResult`. A simpler approach: keep `ConnectionStatus` as-is and add an optional `connectionError` string:

```typescript
// UseResult additions
connection: ConnectionStatus;         // existing
connectionError?: string;             // new — set when connection === 'auth_failed' or 'disconnected' with error detail
```

**Worker side:** The `CONNECTION_STATUS` message gains an optional `error` field:

```typescript
{ type: 'CONNECTION_STATUS', status: 'auth_failed', error: 'NATS: authorization violation' }
```

**Store side:** Store `connectionError` alongside `connectionStatus`. Clear it when status becomes `'connected'`.

### Test App

When `connection === 'auth_failed'`, show a banner:

```
Authentication failed: {connectionError}
```

---

## 3. Conflict Visibility

### Problem

The framework already collects `ConflictRecord[]` and exposes it via `UseResult.conflicts`. The test app ignores it. Developers don't know conflicts are happening.

### Design

No framework changes needed — the signal already exists. This is purely a test app UI change.

Add a conflict indicator to the app header (next to the workspace switcher). When `conflicts.length > 0`, show a badge with the count. Clicking it shows a dropdown listing unresolved conflicts with:
- Table name + record ID
- Field name
- Winner value vs loser value
- Merge strategy used
- "Dismiss" button per conflict (calls `actions.dismissConflict(index)`)

The design follows the workspace switcher dropdown pattern: compact trigger with badge, dropdown with list.

### Conflict Record Shape (already defined)

```typescript
interface ConflictRecord {
    table: string;
    recordId: string;
    field: string;
    winner: { value: unknown; hlc?: number };
    loser: { value: unknown; hlc?: number };
    strategy: string;
    resolvedAt: number;
    dismissed: boolean;
}
```

---

## 4. Authority Staleness

### Problem

Non-monotonic views (e.g., `recentActivity` with `topN`) use the CALM authority path. When the authority POST fails (server down, network error), the client applies exponential backoff up to 30s. During this time, the view shows stale data with no indication.

### Design

Add a per-view `stale` flag. When the authority backoff is active for a view, that view's data is marked stale.

**Worker side:** Track which views are in authority backoff. When backoff activates for a view, send a new message:

```typescript
{ type: 'VIEW_STALENESS', viewName: string, stale: boolean }
```

When backoff clears (successful authority POST), send `stale: false`.

**Store side:** Maintain a `Map<viewId, boolean>` for staleness. Expose it in `UseResult`:

```typescript
// UseResult addition
staleness: Record<string, boolean>;   // { viewName: true } for stale views
```

Or simpler: a `Set<string>` of stale view names.

**Test App:** When a view is stale, show a subtle indicator next to the view's section heading — a yellow dot or "stale" badge. The data is still shown (it's the last known good state), but the user knows it may be outdated.

---

## File Inventory

| File | Change |
|------|--------|
| `packages/client/src/workers/data-worker.js` | HEARTBEAT timer, VIEW_STALENESS messages, error detail in CONNECTION_STATUS |
| `packages/client/src/store.ts` | `workerHealth` signal + heartbeat monitor, `connectionError`, `staleness` map, expose in UseResult |
| `packages/core/src/index.ts` | Export updated types if needed |
| `apps/test/src/App.tsx` | Worker crash banner, auth error display, conflict indicator |
| `apps/test/src/index.css` | Styles for error banner, conflict dropdown, staleness badge |
