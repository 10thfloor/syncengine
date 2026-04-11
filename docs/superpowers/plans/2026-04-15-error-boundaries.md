# Error Boundaries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four framework error signals so developers can see worker crashes, auth failures, merge conflicts, and stale views — all via the existing reactive signal pattern.

**Architecture:** Worker sends heartbeats and staleness events. Store tracks them as reactive signals (useSyncExternalStore). Test app renders error states in the UI. No new React patterns — just new data flowing through the existing message channel.

**Tech Stack:** Web Workers (postMessage), React useSyncExternalStore, CSS for error UI

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/client/src/workers/data-worker.js` | HEARTBEAT timer, CONNECTION_STATUS error field, VIEW_STALENESS messages |
| `packages/client/src/store.ts` | workerHealth signal, connectionError, staleViews map, heartbeat monitor, UseResult + Store type updates |
| `apps/test/src/App.tsx` | Worker crash banner, auth error banner, conflict indicator dropdown |
| `apps/test/src/index.css` | Error banner, conflict dropdown, staleness badge styles |

---

### Task 1: Worker Heartbeat + Health Signal

**Files:**
- Modify: `packages/client/src/workers/data-worker.js`
- Modify: `packages/client/src/store.ts`

- [ ] **Step 1: Add heartbeat timer to worker**

In `packages/client/src/workers/data-worker.js`, find the `handleInit` function. At the very end (after the `initialized = true` and message flush block), add:

```javascript
    // Heartbeat — store monitors this to detect worker crashes
    setInterval(() => {
        self.postMessage({ type: 'HEARTBEAT' });
    }, 5_000);
```

- [ ] **Step 2: Add HEARTBEAT to WorkerOutMessage type in store.ts**

In `packages/client/src/store.ts`, add to the `WorkerOutMessage` union (after the WORKSPACE_REGISTRY line):

```typescript
    | { type: 'HEARTBEAT' }
```

- [ ] **Step 3: Add workerHealth state and heartbeat monitor to store**

After `let connectionStatus: ConnectionStatus = 'connecting';` (around line 463), add:

```typescript
    let workerHealth: 'alive' | 'dead' = 'alive';
    let lastHeartbeat = Date.now();
    const workerHealthSubscribers = new Set<() => void>();
    const heartbeatCheckInterval = setInterval(() => {
        if (Date.now() - lastHeartbeat > 15_000 && workerHealth === 'alive') {
            workerHealth = 'dead';
            workerHealthSubscribers.forEach((fn) => fn());
        }
    }, 5_000);
```

- [ ] **Step 4: Handle HEARTBEAT in worker onmessage**

In the `worker.onmessage` handler, add before the existing switch statement (after the `WORKER_LOADED` if-block):

```typescript
            if (msg.type === 'HEARTBEAT') {
                lastHeartbeat = Date.now();
                if (workerHealth === 'dead') {
                    workerHealth = 'alive';
                    workerHealthSubscribers.forEach((fn) => fn());
                }
                return;
            }
```

- [ ] **Step 5: Add workerHealth subscription to useHook**

After the `subWorkspace` block (around line 953), add:

```typescript
        const subWorkerHealth = useCallback((onChange: () => void) => {
            workerHealthSubscribers.add(onChange);
            return () => { workerHealthSubscribers.delete(onChange); };
        }, []);
        const health = useSyncExternalStore(subWorkerHealth, () => workerHealth);
```

- [ ] **Step 6: Add workerHealth to useHook return**

Update the return statement to include `workerHealth: health`:

```typescript
        return {
            // ... existing fields ...
            workerHealth: health,
        };
```

- [ ] **Step 7: Add workerHealth to storeHandle**

In the `storeHandle` object, add:

```typescript
        get workerHealth() { return workerHealth; },
```

- [ ] **Step 8: Update UseResult and Store types**

Add to `UseResult` interface:

```typescript
    readonly workerHealth: 'alive' | 'dead';
```

Add to `Store` interface:

```typescript
    readonly workerHealth: 'alive' | 'dead';
```

- [ ] **Step 9: Clean up heartbeat in destroy()**

In `destroy()`, add before `worker?.terminate()`:

```typescript
            clearInterval(heartbeatCheckInterval);
            workerHealthSubscribers.clear();
```

- [ ] **Step 10: Type-check**

Run: `npx tsc --noEmit --project packages/client/tsconfig.json`

Expected: No type errors.

- [ ] **Step 11: Commit**

Commit message: `feat(client): worker heartbeat + health signal for crash detection`

---

### Task 2: Connection Error Detail

**Files:**
- Modify: `packages/client/src/workers/data-worker.js`
- Modify: `packages/client/src/store.ts`

- [ ] **Step 1: Add error field to setConnectionStatus in worker**

In `packages/client/src/workers/data-worker.js`, change `setConnectionStatus` (around line 565) from:

```javascript
function setConnectionStatus(status) {
    connectionStatus = status;
    self.postMessage({ type: 'CONNECTION_STATUS', status });
    broadcastDevtoolsStatus();
}
```

To:

```javascript
function setConnectionStatus(status, error) {
    connectionStatus = status;
    self.postMessage({ type: 'CONNECTION_STATUS', status, ...(error ? { error } : {}) });
    broadcastDevtoolsStatus();
}
```

- [ ] **Step 2: Pass error detail from connectNats catch block**

Find the `connectNats` catch block (around line 940). Change:

```javascript
        if (errMsg.includes('authorization') || errMsg.includes('authentication') || errMsg.includes('permission')) {
            setConnectionStatus('auth_failed');
        } else {
            setConnectionStatus('disconnected');
        }
```

To:

```javascript
        if (errMsg.includes('authorization') || errMsg.includes('authentication') || errMsg.includes('permission')) {
            setConnectionStatus('auth_failed', errMsg);
        } else {
            setConnectionStatus('disconnected', errMsg);
        }
```

- [ ] **Step 3: Pass error detail from connectGateway catch block**

Find the `connectGateway` catch block (around line 1036). Apply the same change:

```javascript
        if (errMsg.includes('authorization') || errMsg.includes('authentication') || errMsg.includes('permission')) {
            setConnectionStatus('auth_failed', errMsg);
        } else {
            setConnectionStatus('disconnected', errMsg);
        }
```

- [ ] **Step 4: Update CONNECTION_STATUS type in store.ts**

In the `WorkerOutMessage` union, change the CONNECTION_STATUS line from:

```typescript
    | { type: 'CONNECTION_STATUS'; status: ConnectionStatus }
```

To:

```typescript
    | { type: 'CONNECTION_STATUS'; status: ConnectionStatus; error?: string }
```

- [ ] **Step 5: Add connectionError state to store**

After `let connectionStatus` (line 463), add:

```typescript
    let connectionError: string | undefined;
```

- [ ] **Step 6: Handle error in CONNECTION_STATUS case**

Change the `CONNECTION_STATUS` case (line 671) from:

```typescript
                case 'CONNECTION_STATUS':
                    connectionStatus = msg.status;
                    connectionSubscribers.forEach((fn) => fn());
                    break;
```

To:

```typescript
                case 'CONNECTION_STATUS':
                    connectionStatus = msg.status;
                    connectionError = msg.status === 'connected' ? undefined : msg.error;
                    connectionSubscribers.forEach((fn) => fn());
                    break;
```

- [ ] **Step 7: Add connectionError to useHook return**

In `useHook`, the `connection` subscription already exists. Add `connectionError` to the return:

```typescript
        return {
            // ... existing fields ...
            connectionError,
        };
```

- [ ] **Step 8: Add connectionError to storeHandle**

```typescript
        get connectionError() { return connectionError; },
```

- [ ] **Step 9: Update UseResult and Store types**

Add to `UseResult`:

```typescript
    readonly connectionError?: string;
```

Add to `Store`:

```typescript
    readonly connectionError?: string;
```

- [ ] **Step 10: Type-check**

Run: `npx tsc --noEmit --project packages/client/tsconfig.json`

Expected: No type errors.

- [ ] **Step 11: Commit**

Commit message: `feat(client): connection error detail in CONNECTION_STATUS signal`

---

### Task 3: Authority View Staleness

**Files:**
- Modify: `packages/client/src/workers/data-worker.js`
- Modify: `packages/client/src/store.ts`

- [ ] **Step 1: Emit VIEW_STALENESS from applyAuthorityBackoff**

In `packages/client/src/workers/data-worker.js`, change `applyAuthorityBackoff` (around line 1263) from:

```javascript
function applyAuthorityBackoff(reason) {
    authority.backoff = Math.min((authority.backoff || AUTHORITY_BACKOFF_INITIAL_MS) * 2, AUTHORITY_BACKOFF_MAX_MS);
    authority.backoffUntil = Date.now() + authority.backoff;
    console.warn(`[authority] backing off ${authority.backoff}ms: ${reason}`);
}
```

To:

```javascript
function applyAuthorityBackoff(reason) {
    authority.backoff = Math.min((authority.backoff || AUTHORITY_BACKOFF_INITIAL_MS) * 2, AUTHORITY_BACKOFF_MAX_MS);
    authority.backoffUntil = Date.now() + authority.backoff;
    console.warn(`[authority] backing off ${authority.backoff}ms: ${reason}`);
    // Mark all non-monotonic views as stale
    for (const [viewName, mono] of Object.entries(authority.viewMonotonicity)) {
        if (mono === 'non_monotonic') {
            self.postMessage({ type: 'VIEW_STALENESS', viewName, stale: true });
        }
    }
}
```

- [ ] **Step 2: Clear staleness on successful authority POST**

In `sendToAuthority`, after the successful `authority.backoff = 0` reset (around line 1253), add:

```javascript
        authority.backoff = 0;
        authority.backoffUntil = 0;
        // Clear staleness for this view
        self.postMessage({ type: 'VIEW_STALENESS', viewName, stale: false });
```

- [ ] **Step 3: Add VIEW_STALENESS to WorkerOutMessage**

In `packages/client/src/store.ts`, add to the union:

```typescript
    | { type: 'VIEW_STALENESS'; viewName: string; stale: boolean }
```

- [ ] **Step 4: Add staleViews state to store**

After `let connectionError` (from Task 2), add:

```typescript
    let staleViews: ReadonlySet<string> = new Set();
    const stalenessSubscribers = new Set<() => void>();
```

- [ ] **Step 5: Handle VIEW_STALENESS in worker onmessage**

Add to the switch statement:

```typescript
                case 'VIEW_STALENESS': {
                    const viewId = viewDisplayToId.get(msg.viewName) ?? msg.viewName;
                    const next = new Set(staleViews);
                    if (msg.stale) {
                        next.add(viewId);
                    } else {
                        next.delete(viewId);
                    }
                    staleViews = next;
                    stalenessSubscribers.forEach((fn) => fn());
                    break;
                }
```

- [ ] **Step 6: Add staleViews subscription to useHook**

After the workerHealth subscription, add:

```typescript
        const subStaleness = useCallback((onChange: () => void) => {
            stalenessSubscribers.add(onChange);
            return () => { stalenessSubscribers.delete(onChange); };
        }, []);
        const stale = useSyncExternalStore(subStaleness, () => staleViews);
```

Add to the return:

```typescript
            staleViews: stale,
```

- [ ] **Step 7: Add staleViews to storeHandle and types**

In `storeHandle`:

```typescript
        get staleViews() { return staleViews; },
```

In `UseResult`:

```typescript
    readonly staleViews: ReadonlySet<string>;
```

In `Store`:

```typescript
    readonly staleViews: ReadonlySet<string>;
```

- [ ] **Step 8: Clean up in destroy()**

```typescript
            stalenessSubscribers.clear();
```

- [ ] **Step 9: Type-check**

Run: `npx tsc --noEmit --project packages/client/tsconfig.json`

Expected: No type errors.

- [ ] **Step 10: Commit**

Commit message: `feat(client): per-view staleness signal for authority backoff`

---

### Task 4: Test App Error UI

**Files:**
- Modify: `apps/test/src/App.tsx`
- Modify: `apps/test/src/index.css`

- [ ] **Step 1: Add error banner component**

In `apps/test/src/App.tsx`, add before the `WorkspaceSwitcher` component:

```tsx
function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="error-banner">
      <span className="error-banner-icon">!</span>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Add conflict indicator component**

Add before the `App` export:

```tsx
function ConflictIndicator() {
  const s = useStore<DB>();
  const { conflicts, actions } = s.use({});
  const active = conflicts.filter((c) => !c.dismissed);
  const [open, setOpen] = useState(false);

  if (active.length === 0) return null;

  return (
    <div className="conflict-indicator">
      <button className="conflict-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="conflict-count">{active.length}</span>
        conflicts
      </button>
      {open && (
        <div className="conflict-dropdown">
          <div className="ws-section-label">Merge Conflicts</div>
          {active.map((c, i) => (
            <div key={`${c.table}-${c.recordId}-${c.field}`} className="conflict-item">
              <div className="conflict-detail">
                <span className="conflict-field">{c.table}.{c.field}</span>
                <span className="conflict-strategy">{c.strategy}</span>
              </div>
              <div className="conflict-values">
                <span className="conflict-winner">winner: {String(c.winner.value)}</span>
                <span className="conflict-loser">loser: {String(c.loser.value)}</span>
              </div>
              <button
                className="btn btn-sm"
                onClick={() => { actions.dismissConflict(i); }}
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire error UI into App component**

In the `App` component, update the `s.use()` call to include needed signals:

```typescript
  const { ready, workspace, workerHealth, connection, connectionError } = s.use({ totalSales });
```

Add error banners before the header:

```tsx
  return (
    <div className="app-shell">
      {workerHealth === 'dead' && (
        <ErrorBanner>
          Worker crashed — <button className="btn btn-sm" onClick={() => window.location.reload()}>reload page</button>
        </ErrorBanner>
      )}
      {connection === 'auth_failed' && (
        <ErrorBanner>
          Authentication failed{connectionError ? `: ${connectionError}` : ''}
        </ErrorBanner>
      )}

      <div className="app-header">
        <h1>syncengine storefront</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <ConflictIndicator />
          <span className="user-tag">{userId}</span>
          <WorkspaceSwitcher />
        </div>
      </div>
      {/* ... rest unchanged ... */}
```

- [ ] **Step 4: Add CSS styles**

In `apps/test/src/index.css`, add before the `.select` rule:

```css
/* ── Error Banners ──────────────────────────────────────────── */

.error-banner {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.6rem 1rem;
  background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: var(--radius); color: var(--red);
  font-size: 0.8rem; margin-bottom: 1rem;
}
.error-banner-icon {
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--red); color: white;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.7rem; font-weight: 700; flex-shrink: 0;
}

/* ── Conflict Indicator ─────────────────────────────────────── */

.conflict-indicator { position: relative; }

.conflict-trigger {
  display: inline-flex; align-items: center; gap: 0.3rem;
  background: rgba(234, 179, 8, 0.1); border: 1px solid rgba(234, 179, 8, 0.3);
  border-radius: 6px; padding: 0.2rem 0.5rem;
  color: var(--yellow); font-size: 0.75rem; cursor: pointer;
}
.conflict-count {
  background: var(--yellow); color: var(--bg);
  width: 16px; height: 16px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 0.65rem; font-weight: 700;
}

.conflict-dropdown {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 100;
  min-width: 280px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  padding: 0.5rem; overflow: hidden;
}

.conflict-item {
  padding: 0.5rem; border-bottom: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 0.3rem;
}
.conflict-item:last-child { border-bottom: none; }
.conflict-detail { display: flex; justify-content: space-between; align-items: center; }
.conflict-field { font-family: var(--mono); font-size: 0.75rem; color: var(--fg); }
.conflict-strategy { font-family: var(--mono); font-size: 0.65rem; color: var(--muted); }
.conflict-values { font-size: 0.7rem; color: var(--fg-dim); display: flex; gap: 0.75rem; }
.conflict-winner { color: var(--green); }
.conflict-loser { color: var(--red); text-decoration: line-through; }

/* ── Staleness Badge ────────────────────────────────────────── */

.stale-badge {
  display: inline-block; font-family: var(--mono); font-size: 0.6rem;
  padding: 1px 5px; border-radius: 3px;
  background: rgba(234, 179, 8, 0.12); color: var(--yellow);
  margin-left: 0.4rem; vertical-align: middle;
}
```

- [ ] **Step 5: Type-check and verify**

Run: `npx tsc --noEmit --project apps/test/tsconfig.json 2>&1 | grep -v vite-plugin`

Expected: No errors in test app files.

- [ ] **Step 6: Commit**

Commit message: `feat(test): error UI — worker crash banner, auth error, conflict indicator, staleness styles`
