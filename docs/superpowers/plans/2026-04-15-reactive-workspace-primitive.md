# Reactive Workspace Primitive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workspace a reactive, runtime-switchable primitive so the entire sync stack tears down and rebuilds when the workspace changes.

**Architecture:** Actor model — the worker owns workspace identity. Main thread sends `SWITCH_WORKSPACE` commands, observes `WORKSPACE_STATUS` events. An epoch counter guards all async callbacks against stale results from superseded workspace switches. SQLite, BroadcastChannel, and NATS connections are all workspace-scoped.

**Tech Stack:** Web Workers, SQLite WASM (OPFS), NATS JetStream (via gateway WebSocket), React `useSyncExternalStore`, BroadcastChannel API

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/client/src/workers/data-worker.js` | Epoch counter, `teardownWorkspace()`, `handleSwitchWorkspace()`, workspace-scoped SQLite/BroadcastChannel, epoch guards on async callbacks |
| `packages/client/src/store.ts` | `workspaceStatus` signal, `setWorkspace()`, `WORKSPACE_STATUS` message handler, workspace-aware `ready` |
| `packages/core/src/index.ts` | `WorkspaceStatus` and `WorkspaceInfo` type exports |
| `apps/test/src/App.tsx` | `WorkspaceSwitcher` component — input + status badge |

---

### Task 1: Add Epoch Counter and Teardown Function to Worker

**Files:**
- Modify: `packages/client/src/workers/data-worker.js` (engine state section, lines 27-35)
- Modify: `packages/client/src/workers/data-worker.js` (BroadcastChannel section, lines 144-169)

This task adds the epoch counter and a `teardownWorkspace()` function that resets all workspace-scoped state. No new message handling yet — just the foundation.

- [ ] **Step 1: Add epoch counter and workspace status emitter**

Add after `let schemaTables = [];` (line 35):

```javascript
// ── Workspace lifecycle ────────────────────────────────────────────────────
let epoch = 0;
let currentWsKey = null;

function isCurrentEpoch(capturedEpoch) {
    return capturedEpoch === epoch;
}

function emitWorkspaceStatus(wsKey, requestId, status, error) {
    self.postMessage({
        type: 'WORKSPACE_STATUS',
        wsKey,
        requestId,
        status,
        ...(error ? { error } : {}),
    });
}
```

- [ ] **Step 2: Add teardownWorkspace function**

Add after the workspace lifecycle block from step 1:

```javascript
/**
 * Tear down all workspace-scoped state. Called before switching to a new
 * workspace. Best-effort: connections are closed non-blocking, in-memory
 * state is cleared synchronously.
 */
function teardownWorkspace() {
    // 1. Close connections
    if (nats.gwWs) {
        try { nats.gwWs.close(); } catch { /* best effort */ }
        nats.gwWs = null;
    }
    if (nats.conn) {
        try { nats.conn.close(); } catch { /* best effort */ }
        nats.conn = null;
    }
    for (const source of nats.subs) {
        try { source.messages.stop(); } catch { /* best effort */ }
    }
    nats.subs = [];
    if (nats.peerAckTimer) { clearInterval(nats.peerAckTimer); nats.peerAckTimer = null; }

    // 2. Unsubscribe topics (keep desired set — it represents app intent)
    for (const [, sub] of topicState.subs) {
        try { sub.natsSub?.unsubscribe?.(); } catch { /* best effort */ }
    }
    topicState.subs.clear();

    // 3. Clear NATS outbound queues
    nats.outboundQueues = {};
    nats.config = null;
    nats.routing = null;

    // 4. Reset DBSP engine (schema survives, materialized state doesn't)
    if (dbsp) dbsp.reset();

    // 5. Clear in-memory state
    for (const key of Object.keys(viewRowCounts)) delete viewRowCounts[key];
    for (const key of Object.keys(viewRowCache)) delete viewRowCache[key];
    undoStack.length = 0;
    causalQueue.length = 0;
    seenNonces.clear();
    nonceSeq = 0;
    hlcTs = 0;
    hlcCount = 0;
    conflictLog.length = 0;

    // 6. Reset sync state
    sync.phase = 'idle';
    sync.lastProcessedSeqs = {};
    sync.isReplaying = false;
    sync.localMutationQueue = [];
    replayCoord.caughtUp.clear();
    replayCoord.expected = 0;
    replayCoord.finalizeLatch = null;

    // 7. Reset authority
    authority.sub = null;
    authority.seqs = {};
    authority.backoff = 0;
    authority.backoffUntil = 0;

    // 8. Close SQLite
    if (db) {
        try { db.close(); } catch { /* best effort */ }
        db = null;
    }

    // 9. Close BroadcastChannel
    if (channel) {
        try { channel.close(); } catch { /* best effort */ }
    }

    connectionStatus = 'disconnected';
    initialized = false;
}
```

- [ ] **Step 3: Make BroadcastChannel mutable**

Change line 146 from `const` to `let`:

```javascript
let channel = new BroadcastChannel('react-dbsp-sync');
```

Extract the existing `channel.onmessage` handler (lines 148-161) into a named function:

```javascript
function handleBroadcastMessage(event) {
    if (!initialized) return;
    const msg = event.data;
    if (msg._nonce && dedup(msg._nonce)) return;

    if (msg.type === 'RESET') {
        dbsp.reset();
        self.postMessage({ type: 'FULL_SYNC', snapshots: {} });
        return;
    }
    if (msg.type === 'DELTAS' && msg.viewUpdates) {
        emitViewUpdates(msg.viewUpdates);
    }
}

channel.onmessage = handleBroadcastMessage;
```

- [ ] **Step 4: Verify the worker still loads**

Run: `cd apps/test && pnpm dev`

Expected: App loads normally, no console errors. The new code is defined but not yet called.

- [ ] **Step 5: Commit**

Commit message: `feat(client): add epoch counter and teardownWorkspace to data-worker`

---

### Task 2: Add SWITCH_WORKSPACE Handler to Worker

**Files:**
- Modify: `packages/client/src/workers/data-worker.js` (handleInit, message router)

Extract a reusable workspace init path, then build `handleSwitchWorkspace` on top of teardown + init.

- [ ] **Step 1: Make SQLite path workspace-scoped in handleInit**

In `handleInit`, change the hardcoded path (line 1406):

```javascript
    // 2. SQLite with OPFS persistence
    const sqlite3 = await sqlite3InitModule();
    const wsKey = data.sync?.workspaceId || 'default';
    currentWsKey = wsKey;
    const dbPath = `/syncengine-${wsKey}.sqlite3`;
```

- [ ] **Step 2: Scope the BroadcastChannel in handleInit**

After SQLite init in `handleInit`, replace the default channel with a workspace-scoped one:

```javascript
    // Close default channel, open workspace-scoped one
    try { channel.close(); } catch { /* ignore */ }
    channel = new BroadcastChannel(`syncengine-sync-${wsKey}`);
    channel.onmessage = handleBroadcastMessage;
```

- [ ] **Step 3: Save sync config for reuse during workspace switch**

In `handleInit`, after `nats.config = data.sync;` (line 1506), add:

```javascript
        nats._lastSyncConfig = { ...data.sync };
```

- [ ] **Step 4: Add handleSwitchWorkspace function**

Add before `handleInit`:

```javascript
async function handleSwitchWorkspace(data) {
    const { wsKey, requestId } = data;

    // Supersede: increment epoch, invalidating all in-flight async work
    epoch++;
    const myEpoch = epoch;

    // Teardown old workspace
    teardownWorkspace();
    emitWorkspaceStatus(wsKey, requestId, 'switching');

    if (!isCurrentEpoch(myEpoch)) return;

    // Build new sync config from stored schema + new wsKey
    const syncConfig = { ...nats._lastSyncConfig, workspaceId: wsKey };
    currentWsKey = wsKey;

    // 1. Open workspace-scoped SQLite
    emitWorkspaceStatus(wsKey, requestId, 'provisioning');
    try {
        const sqlite3 = await sqlite3InitModule();
        const dbPath = `/syncengine-${wsKey}.sqlite3`;
        if (sqlite3.oo1.OpfsDb) {
            db = new sqlite3.oo1.OpfsDb(dbPath);
        } else {
            db = new sqlite3.oo1.DB(dbPath, 'ct');
        }
    } catch (err) {
        if (isCurrentEpoch(myEpoch)) {
            emitWorkspaceStatus(wsKey, requestId, 'error', `SQLite init failed: ${err.message}`);
        }
        return;
    }
    if (!isCurrentEpoch(myEpoch)) return;

    // 2. Create tables, check schema fingerprint, load high-water marks
    const schemaFingerprint = computeSchemaFingerprint({ tables: _schemaTables, views: _schemaViews });
    try {
        db.exec("CREATE TABLE IF NOT EXISTS _dbsp_meta (key TEXT PRIMARY KEY, value TEXT)");
        const rows = db.exec(
            "SELECT value FROM _dbsp_meta WHERE key = 'schema_fingerprint'",
            { rowMode: 'object' },
        );
        const stored = rows.length > 0 ? rows[0].value : null;
        if (stored && stored !== schemaFingerprint) {
            const existingTables = db.exec(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                { rowMode: 'object' },
            );
            for (const row of existingTables) {
                db.exec(`DROP TABLE IF EXISTS "${row.name}"`);
            }
            db.exec("CREATE TABLE IF NOT EXISTS _dbsp_meta (key TEXT PRIMARY KEY, value TEXT)");
        }
        db.exec(
            "INSERT OR REPLACE INTO _dbsp_meta (key, value) VALUES ('schema_fingerprint', ?)",
            { bind: [schemaFingerprint] },
        );
        for (const t of _schemaTables) {
            db.exec(t.sql);
            tablesMeta[t.name] = { insertSql: t.insertSql, columns: t.columns };
        }
    } catch (err) {
        if (isCurrentEpoch(myEpoch)) {
            emitWorkspaceStatus(wsKey, requestId, 'error', `Schema init failed: ${err.message}`);
        }
        return;
    }
    if (!isCurrentEpoch(myEpoch)) return;

    // 3. Hydrate DBSP from SQLite + load high-water marks
    dbsp.reset();
    hydrateFromSQLite(_schemaTables);
    loadLastProcessedSeqs();

    // 4. Open workspace-scoped BroadcastChannel
    try { channel.close(); } catch { /* ignore */ }
    channel = new BroadcastChannel(`syncengine-sync-${wsKey}`);
    channel.onmessage = handleBroadcastMessage;

    initialized = true;
    self.postMessage({ type: 'READY' });

    if (!isCurrentEpoch(myEpoch)) return;

    // 5. Connect to NATS/gateway
    emitWorkspaceStatus(wsKey, requestId, 'connecting');

    nats.config = syncConfig;
    nats._lastSyncConfig = syncConfig;
    if (syncConfig.restateUrl) authority.restateUrl = syncConfig.restateUrl;

    nats.routing = buildChannelRouting(syncConfig, _schemaTables.map(t => t.name));
    for (const s of nats.routing.subjects) {
        if (!nats.outboundQueues[s]) nats.outboundQueues[s] = [];
    }

    // Build channel name mappings
    const channelNames = [];
    const channelNameToSubject = {};
    if (syncConfig.channels) {
        for (const ch of syncConfig.channels) {
            const chName = ch.name;
            const subject = `ws.${syncConfig.workspaceId}.ch.${chName}.deltas`;
            channelNames.push(chName);
            channelNameToSubject[chName] = subject;
        }
    }
    if (channelNames.length === 0 && nats.routing.subjects.length === 1) {
        channelNames.push('__default__');
        channelNameToSubject['__default__'] = nats.routing.subjects[0];
    }
    const subjectToChannelName = {};
    for (const [chName, subj] of Object.entries(channelNameToSubject)) {
        subjectToChannelName[subj] = chName;
    }
    nats.routing.channelNames = channelNames;
    nats.routing.channelNameToSubject = channelNameToSubject;
    nats.routing.subjectToChannelName = subjectToChannelName;
    nats.routing.entityWritesSubject = `ws.${syncConfig.workspaceId}.entity-writes`;

    // Store requestId so sync status transitions can emit workspace status
    nats._currentRequestId = requestId;

    if (syncConfig.gatewayUrl) {
        connectGateway();
    } else {
        connectNats();
    }
}
```

- [ ] **Step 5: Wire SWITCH_WORKSPACE into the message router**

Find the main `self.onmessage` handler. Add the case:

```javascript
        case 'SWITCH_WORKSPACE':
            handleSwitchWorkspace(data);
            return;
```

- [ ] **Step 6: Emit WORKSPACE_STATUS from sync status transitions**

In the `emitSyncStatus` function, after the existing `self.postMessage`, add:

```javascript
    if (nats._currentRequestId) {
        if (phase === 'replaying') {
            emitWorkspaceStatus(currentWsKey, nats._currentRequestId, 'replaying');
        } else if (phase === 'live') {
            emitWorkspaceStatus(currentWsKey, nats._currentRequestId, 'live');
            nats._currentRequestId = null;
        }
    }
```

- [ ] **Step 7: Verify worker handles the new message type**

Run: `cd apps/test && pnpm dev`

Expected: App loads normally. No syntax errors.

- [ ] **Step 8: Commit**

Commit message: `feat(client): add SWITCH_WORKSPACE handler with epoch-guarded lifecycle`

---

### Task 3: Add Epoch Guards to Async Callbacks

**Files:**
- Modify: `packages/client/src/workers/data-worker.js` (connectNats, connectGateway, processConsumer)

Add epoch checks to all long-lived async operations so stale callbacks from a previous workspace are discarded.

- [ ] **Step 1: Guard connectNats**

At the top of `connectNats()`, capture epoch:

```javascript
async function connectNats() {
    if (!nats.config) return;
    if (!nats.routing) {
        console.warn('[nats] cannot connect: channel routing not initialized');
        return;
    }
    const myEpoch = epoch;
```

After `nats.conn = await wsconnect(connectOpts);`, add:

```javascript
        if (!isCurrentEpoch(myEpoch)) {
            try { nats.conn.close(); } catch { /* stale */ }
            return;
        }
```

Guard the reconnect timeout in the `catch` block:

```javascript
        if (isCurrentEpoch(myEpoch)) {
            setTimeout(() => connectNats(), NATS_RECONNECT_RETRY_MS);
        }
```

- [ ] **Step 2: Guard connectGateway**

Same pattern — capture `epoch` at top, check after `await connectToGateway(...)`:

```javascript
async function connectGateway() {
    if (!nats.config || !nats.routing) return;
    const myEpoch = epoch;
```

After the `const ws = await connectToGateway(...)` call, add:

```javascript
        if (!isCurrentEpoch(myEpoch)) { ws.close(); return; }
```

In the `onClose` callback, guard the reconnect:

```javascript
            onClose: () => {
                // ... existing cleanup ...
                if (isCurrentEpoch(myEpoch)) {
                    setTimeout(() => connectGateway(), NATS_RECONNECT_DELAY_MS);
                }
            },
```

Guard the catch block reconnect:

```javascript
        if (isCurrentEpoch(myEpoch)) {
            setTimeout(() => connectGateway(), NATS_RECONNECT_RETRY_MS);
        }
```

- [ ] **Step 3: Guard processConsumer**

At the top of `processConsumer`, capture epoch. Inside the `for await` loop, check at the start of each iteration:

```javascript
async function processConsumer(codec, { subject, consumer, messages, skipReplay }) {
    const myEpoch = epoch;
    try {
        for await (const raw of messages) {
            if (!isCurrentEpoch(myEpoch)) break;
            // ... existing processing unchanged ...
        }
    } catch (e) {
        if (isCurrentEpoch(myEpoch)) {
            console.log(`[sync] consumer loop for ${subject} ended:`, e?.message || 'closed');
        }
    }
}
```

- [ ] **Step 4: Verify no stale reconnects**

Run: `cd apps/test && pnpm dev`

Expected: App loads, connects. No errors.

- [ ] **Step 5: Commit**

Commit message: `feat(client): add epoch guards to NATS/gateway/consumer async callbacks`

---

### Task 4: Add Workspace Signal to Store

**Files:**
- Modify: `packages/core/src/index.ts` (type exports)
- Modify: `packages/client/src/store.ts` (state, setWorkspace, onmessage handler, useHook return, storeHandle, destroy)

- [ ] **Step 1: Add WorkspaceStatus types to core**

In `packages/core/src/index.ts`, find the existing type exports section and add:

```typescript
export type WorkspaceStatus = 'switching' | 'provisioning' | 'connecting' | 'replaying' | 'live' | 'error';

export interface WorkspaceInfo {
    readonly wsKey: string;
    readonly status: WorkspaceStatus;
    readonly error?: string;
}
```

- [ ] **Step 2: Import new types in store.ts**

Add `WorkspaceInfo` and `WorkspaceStatus` to the import from `@syncengine/core` (line 26):

```typescript
    type WorkspaceInfo,
    type WorkspaceStatus,
```

- [ ] **Step 3: Add workspace state variables**

After `let syncStatus` (around line 452), add:

```typescript
    let workspaceStatus: WorkspaceInfo = {
        wsKey: runtimeWorkspaceId ?? 'default',
        status: 'live',
    };
    let lastWsRequestId: string | null = null;
    const workspaceSubscribers = new Set<() => void>();
```

- [ ] **Step 4: Add setWorkspace function**

After the workspace state variables:

```typescript
    function setWorkspace(wsKey: string): void {
        if (wsKey === workspaceStatus.wsKey && workspaceStatus.status === 'live') return;
        const requestId = crypto.randomUUID();
        lastWsRequestId = requestId;
        workspaceStatus = { wsKey, status: 'switching' };
        workspaceSubscribers.forEach((fn) => fn());

        for (const viewId of viewSnapshots.keys()) {
            viewSnapshots.set(viewId, []);
            notifyView(viewId);
        }
        ready = false;
        readyListeners.clear();
        seedsApplied = false;
        pendingViewClear = false;

        topicPeers.clear();
        for (const [, subs] of topicSubscribers) {
            subs.forEach((fn) => fn());
        }

        send({ type: 'SWITCH_WORKSPACE', wsKey, requestId } as any);
    }
```

- [ ] **Step 5: Handle WORKSPACE_STATUS in worker onmessage**

In the `worker.onmessage` switch statement, add after the `TOPIC_UPDATE` case:

```typescript
                case 'WORKSPACE_STATUS': {
                    if (msg.requestId !== lastWsRequestId) break;
                    workspaceStatus = {
                        wsKey: msg.wsKey,
                        status: msg.status as WorkspaceStatus,
                        ...(msg.error ? { error: msg.error } : {}),
                    };
                    workspaceSubscribers.forEach((fn) => fn());
                    break;
                }
```

- [ ] **Step 6: Add workspace subscription to useHook**

After the `subUndo` block (around line 838), add:

```typescript
        const subWorkspace = useCallback((onChange: () => void) => {
            workspaceSubscribers.add(onChange);
            return () => { workspaceSubscribers.delete(onChange); };
        }, []);
        const workspace = useSyncExternalStore(subWorkspace, () => workspaceStatus);
```

Update the return (line 851):

```typescript
        return {
            views: viewData as UseResult<TViews>['views'],
            ready: isReady,
            connection,
            sync,
            conflicts,
            undo: undoObj,
            actions,
            workspace,
            setWorkspace,
        };
```

- [ ] **Step 7: Add workspace to storeHandle**

In the `storeHandle` object (line 962), add alongside existing properties:

```typescript
        get workspace() { return workspaceStatus; },
        setWorkspace,
```

- [ ] **Step 8: Update UseResult and Store types**

Find the `UseResult` type definition. Add:

```typescript
    workspace: WorkspaceInfo;
    setWorkspace: (wsKey: string) => void;
```

Find the `Store` type definition. Add:

```typescript
    readonly workspace: WorkspaceInfo;
    setWorkspace(wsKey: string): void;
```

- [ ] **Step 9: Clean up workspace subscribers in destroy()**

In `destroy()` (line 986), add:

```typescript
            workspaceSubscribers.clear();
```

- [ ] **Step 10: Type-check**

Run: `cd packages/client && pnpm typecheck`

Expected: No type errors.

- [ ] **Step 11: Commit**

Commit message: `feat(client): add workspace signal, setWorkspace, and WORKSPACE_STATUS to store`

---

### Task 5: Test App Workspace Switcher

**Files:**
- Modify: `apps/test/src/App.tsx`

- [ ] **Step 1: Add WorkspaceSwitcher component and wire into App**

Add imports at top of `App.tsx`:

```tsx
import { useState, useMemo, useCallback } from "react";
import { hashWorkspaceId } from "@syncengine/core/http";
```

Add the `WorkspaceSwitcher` component before the `App` default export:

```tsx
function WorkspaceSwitcher() {
  const s = useStore<DB>();
  const { workspace, setWorkspace } = s.use({ totalSales });
  const [input, setInput] = useState("");

  const handleSwitch = useCallback(() => {
    if (!input.trim()) return;
    setWorkspace(hashWorkspaceId(input.trim()));
    setInput("");
  }, [input, setWorkspace]);

  const statusColors: Record<string, string> = {
    live: "#22c55e",
    switching: "#eab308",
    provisioning: "#eab308",
    connecting: "#eab308",
    replaying: "#3b82f6",
    error: "#ef4444",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem" }}>
      <span style={{
        background: statusColors[workspace.status] ?? "#71717a",
        color: "white",
        padding: "2px 8px",
        borderRadius: "4px",
        fontFamily: "monospace",
        fontSize: "0.75rem",
      }}>
        {workspace.wsKey.slice(0, 8)}{"\u2026"} {workspace.status}
      </span>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSwitch()}
        placeholder="workspace id"
        style={{
          background: "#27272a",
          border: "1px solid #3f3f46",
          borderRadius: "4px",
          color: "#e4e4e7",
          padding: "2px 8px",
          width: "120px",
          fontSize: "0.75rem",
        }}
      />
      <button onClick={handleSwitch} style={{
        background: "#3f3f46",
        border: "none",
        borderRadius: "4px",
        color: "#e4e4e7",
        padding: "2px 8px",
        cursor: "pointer",
        fontSize: "0.75rem",
      }}>Switch</button>
    </div>
  );
}
```

Place `<WorkspaceSwitcher />` in the App layout, in the header area next to the tab bar.

- [ ] **Step 2: Verify end-to-end workspace switching**

Run: `cd apps/test && pnpm dev`

Test sequence:
1. App loads — badge shows `<wsKey>… live` in green
2. Type "test-workspace" in input, press Enter
3. Badge transitions: switching (yellow) → provisioning → connecting → replaying → live (green)
4. Views clear during switch, then show empty (new workspace has no data)
5. Add some data in the new workspace
6. Type "default" and switch back — original data reappears
7. Switch back to "test-workspace" — data from step 5 reappears (persisted in separate SQLite file)

- [ ] **Step 3: Test rapid switching**

Click Switch rapidly with "ws-a", "ws-b", "ws-c". Only the final workspace should reach `live`. No errors in console.

- [ ] **Step 4: Commit**

Commit message: `feat(test): add workspace switcher UI to exercise reactive workspace primitive`

---

### Task 6: Cross-Tab Isolation Verification

**Files:** None (manual testing)

- [ ] **Step 1: Verify BroadcastChannel isolation**

1. Open two tabs at `http://localhost:5173`
2. In tab 1, switch to workspace "shared"
3. In tab 2, stay on default workspace
4. Create data in tab 1
5. Verify tab 2 does NOT receive tab 1's deltas
6. In tab 2, switch to workspace "shared"
7. Verify tab 2 now sees tab 1's data

- [ ] **Step 2: Verify error recovery**

1. Stop the dev server (Ctrl-C)
2. In the browser, try switching workspace
3. Badge should show `error`
4. Restart dev server
5. Switch workspace again
6. Should recover to `live`

- [ ] **Step 3: Commit any fixes**

Commit message: `fix(client): address issues found during workspace switching verification`
