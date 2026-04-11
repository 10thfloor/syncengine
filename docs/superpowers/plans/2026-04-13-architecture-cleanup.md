# Architecture Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate three architectural debts identified in code review: RPC proxy duplication, NATS subject leakage through the gateway protocol, and gateway handshake duplication.

**Architecture:** Extract a shared RPC proxy module consumed by both dev and prod servers. Refactor the gateway protocol to carry semantic fields instead of raw NATS subjects. Extract a shared gateway connection factory for the client.

**Tech Stack:** TypeScript, existing packages.

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `packages/server/src/rpc-proxy.ts` | Shared RPC routing logic (entity + workflow) |
| `packages/client/src/gateway-connection.ts` | Shared gateway WebSocket connection factory |

### Modified files

| File | What changes |
|------|-------------|
| `packages/vite-plugin/src/actors.ts` | Replace inline RPC routing with shared proxy |
| `packages/server/src/serve.ts` | Replace inline RPC routing with shared proxy |
| `packages/server/src/gateway/protocol.ts` | Change publish messages to use semantic fields |
| `packages/server/src/gateway/server.ts` | Update publish handler to read semantic fields |
| `packages/client/src/workers/data-worker.js` | Use semantic fields in publish, use gateway-connection factory |
| `packages/client/src/entity-client.ts` | Use gateway-connection factory |

---

### Task 1: Shared RPC Proxy Module

Extract the duplicated RPC routing from `actors.ts` and `serve.ts` into a shared module.

**Files:**
- Create: `packages/server/src/rpc-proxy.ts`
- Modify: `packages/vite-plugin/src/actors.ts`
- Modify: `packages/server/src/serve.ts`

- [ ] **Step 1: Create rpc-proxy.ts**

The shared module handles both entity and workflow URL construction + validation, abstracting over the different HTTP APIs (Vite's Connect middleware vs Node's raw `http.IncomingMessage`).

```typescript
// packages/server/src/rpc-proxy.ts
import { ENTITY_OBJECT_PREFIX } from './entity-runtime.js';
import { WORKFLOW_OBJECT_PREFIX } from './workflow.js';

const NAME_REGEX = /^([a-zA-Z]|_[a-zA-Z0-9])[a-zA-Z0-9_]*$/;
const WORKSPACE_HEADER_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export { NAME_REGEX, WORKSPACE_HEADER_REGEX };

export interface RpcTarget {
    url: string;
    body: string;
}

export interface RpcError {
    status: number;
    message: string;
}

/**
 * Parse and validate a workflow RPC path, returning the Restate target URL.
 * Returns an RpcError if validation fails.
 */
export function resolveWorkflowTarget(
    pathname: string,
    workspaceId: string,
    restateUrl: string,
): RpcTarget | RpcError {
    const wfParts = pathname.slice('/__syncengine/rpc/workflow/'.length).split('/');
    if (wfParts.length !== 2) {
        return { status: 400, message: 'Expected /__syncengine/rpc/workflow/<name>/<invocationId>' };
    }
    const [wfNameRaw, invocationIdRaw] = wfParts as [string, string];
    let wfName: string;
    let invocationId: string;
    try {
        wfName = decodeURIComponent(wfNameRaw);
        invocationId = decodeURIComponent(invocationIdRaw);
    } catch {
        return { status: 400, message: 'Malformed URL-encoded path component' };
    }
    if (!NAME_REGEX.test(wfName)) {
        return { status: 400, message: 'Invalid workflow name' };
    }
    // eslint-disable-next-line no-control-regex
    if (invocationId.length === 0 || invocationId.length > 512 || /[\x00-\x1f]/.test(invocationId)) {
        return { status: 400, message: 'Invalid invocationId' };
    }
    const url =
        `${restateUrl.replace(/\/+$/, '')}/${WORKFLOW_OBJECT_PREFIX}${wfName}` +
        `/${encodeURIComponent(`${workspaceId}/${invocationId}`)}/run`;
    return { url, body: '' };
}

/**
 * Parse and validate an entity RPC path, returning the Restate target URL.
 * Returns an RpcError if validation fails.
 */
export function resolveEntityTarget(
    pathname: string,
    workspaceId: string,
    restateUrl: string,
): RpcTarget | RpcError {
    const pathParts = pathname.slice('/__syncengine/rpc/'.length).split('/');
    if (pathParts.length !== 3) {
        return { status: 400, message: 'Expected /__syncengine/rpc/<entity>/<key>/<handler>' };
    }
    const [entityNameRaw, entityKeyRaw, handlerNameRaw] = pathParts as [string, string, string];
    let entityName: string;
    let entityKey: string;
    let handlerName: string;
    try {
        entityName = decodeURIComponent(entityNameRaw);
        entityKey = decodeURIComponent(entityKeyRaw);
        handlerName = decodeURIComponent(handlerNameRaw);
    } catch {
        return { status: 400, message: 'Malformed URL-encoded path component' };
    }
    if (!NAME_REGEX.test(entityName) || !NAME_REGEX.test(handlerName)) {
        return { status: 400, message: 'Invalid entity or handler name' };
    }
    // eslint-disable-next-line no-control-regex
    if (entityKey.length === 0 || entityKey.length > 512 || /[\/\\\x00-\x1f]/.test(entityKey)) {
        return { status: 400, message: 'Invalid entity key' };
    }
    const url =
        `${restateUrl.replace(/\/+$/, '')}/${ENTITY_OBJECT_PREFIX}${entityName}` +
        `/${encodeURIComponent(`${workspaceId}/${entityKey}`)}` +
        `/${handlerName}`;
    return { url, body: '' };
}

/**
 * Resolve workspace ID from request headers with a fallback.
 */
export function resolveWorkspaceId(
    headerValue: string | string[] | undefined,
    fallback: () => string,
): string | RpcError {
    const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (typeof value === 'string' && value.length > 0) {
        if (!WORKSPACE_HEADER_REGEX.test(value)) {
            return { status: 400, message: 'Invalid x-syncengine-workspace header' };
        }
        return value;
    }
    return fallback();
}

export function isRpcError(result: RpcTarget | RpcError | string): result is RpcError {
    return typeof result === 'object' && 'status' in result && !('url' in result);
}
```

- [ ] **Step 2: Refactor actors.ts to use shared proxy**

Replace the inline workflow RPC block (~lines 592-664) and entity RPC block (~lines 666-750) with calls to `resolveWorkflowTarget`, `resolveEntityTarget`, and `resolveWorkspaceId`. The fetch + error handling stays inline (different response APIs), but all validation and URL construction is shared.

```typescript
// In buildRpcMiddleware:
import { resolveWorkflowTarget, resolveEntityTarget, resolveWorkspaceId, isRpcError } from '@syncengine/server/rpc-proxy';

// Workflow route:
if (req.url.startsWith('/__syncengine/rpc/workflow/')) {
    const wsResult = resolveWorkspaceId(req.headers['x-syncengine-workspace'], workspaceIdFallbackFn);
    if (isRpcError(wsResult)) { res.statusCode = wsResult.status; res.end(wsResult.message); return; }
    const target = resolveWorkflowTarget(pathname, wsResult, restateUrlFn());
    if (isRpcError(target)) { res.statusCode = target.status; res.end(target.message); return; }
    // ... read body, fetch target.url, proxy response
}
```

- [ ] **Step 3: Refactor serve.ts to use shared proxy**

Same pattern — replace the inline workflow and entity routing blocks with shared proxy calls. The `handleRpc` function shrinks from ~130 lines to ~50.

- [ ] **Step 4: Add rpc-proxy export to server package.json**

Add `"./rpc-proxy": "./src/rpc-proxy.ts"` to the `exports` map in `packages/server/package.json`.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/server && npx vitest run && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(rpc): extract shared RPC proxy module, eliminate routing duplication"
```

---

### Task 2: Semantic Gateway Protocol (remove NATS subject leakage)

Change publish messages from carrying raw NATS subjects to semantic fields.

**Files:**
- Modify: `packages/server/src/gateway/protocol.ts`
- Modify: `packages/server/src/gateway/server.ts`
- Modify: `packages/client/src/workers/data-worker.js`

- [ ] **Step 1: Update protocol types**

In `protocol.ts`, change the publish message types:

```typescript
// Before:
export interface ClientPublishDeltaMessage {
    type: 'publish';
    kind: 'delta';
    subject: string;           // raw NATS subject
    payload: Record<string, unknown>;
}

export interface ClientPublishTopicMessage {
    type: 'publish';
    kind: 'topic';
    subject: string;           // raw NATS subject
    payload: Record<string, unknown>;
}

// After:
export interface ClientPublishDeltaMessage {
    type: 'publish';
    kind: 'delta';
    channel: string;           // channel name (gateway resolves to NATS subject)
    payload: Record<string, unknown>;
}

export interface ClientPublishTopicMessage {
    type: 'publish';
    kind: 'topic';
    name: string;              // topic name
    key: string;               // topic key
    payload: Record<string, unknown>;
}
```

- [ ] **Step 2: Update server.ts publish handler**

In `server.ts`, the `case 'publish':` block currently parses `msg.subject.split('.')`. Change to read semantic fields directly:

```typescript
case 'publish':
    if (msg.kind === 'delta') {
        const subject = `ws.${bridge.workspaceId}.ch.${msg.channel}.deltas`;
        bridge.publishDelta(subject, msg.payload);
    } else if (msg.kind === 'topic') {
        bridge.publishTopicLocal(msg.name, msg.key, msg.payload, session.clientId);
    } else if (msg.kind === 'authority') {
        void bridge.publishAuthority(msg.viewName, msg.deltas, authToken);
    }
    break;
```

No more `split('.')` — the gateway constructs the NATS subject from semantic fields.

- [ ] **Step 3: Update data-worker.js publish paths**

In `data-worker.js`, change the gateway publish calls to send semantic fields instead of constructing NATS subjects:

For delta publishes (in `natsPublish` gateway branch):
```javascript
// Before:
nats.gwWs.send(JSON.stringify({ type: 'publish', kind: 'delta', subject: s, payload: msg }));

// After — resolve subject back to channel name:
const chName = nats.routing.subjectToChannelName?.[s];
if (chName) {
    nats.gwWs.send(JSON.stringify({ type: 'publish', kind: 'delta', channel: chName, payload: msg }));
}
```

Add a reverse lookup `subjectToChannelName` alongside `channelNameToSubject` in `handleInit`.

For topic publishes:
```javascript
// Before:
nats.gwWs.send(JSON.stringify({ type: 'publish', kind: 'topic', subject, payload: {...} }));

// After:
nats.gwWs.send(JSON.stringify({ type: 'publish', kind: 'topic', name, key, payload: {...} }));
```

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(gateway): replace raw NATS subjects with semantic protocol fields"
```

---

### Task 3: Shared Gateway Connection Factory

Extract the duplicated WebSocket open → init → ready handshake from `data-worker.js` and `entity-client.ts`.

**Files:**
- Create: `packages/client/src/gateway-connection.ts`
- Modify: `packages/client/src/entity-client.ts`
- Modify: `packages/client/src/workers/data-worker.js`

- [ ] **Step 1: Create gateway-connection.ts**

A factory function that handles the WebSocket lifecycle: open, init handshake, ready wait, message routing, reconnect on close.

```typescript
// packages/client/src/gateway-connection.ts

export interface GatewayConnectionConfig {
    url: string;
    workspaceId: string;
    channels: string[];
    clientId: string;
    authToken?: string;
    onMessage: (msg: Record<string, unknown>) => void;
    onClose?: () => void;
    onReady?: () => void;
}

/**
 * Open a gateway WebSocket, perform the init/ready handshake, and route
 * messages. Returns a Promise that resolves with the open WebSocket after
 * the ready handshake completes.
 *
 * Used by both data-worker.js (channels + topics) and entity-client.ts
 * (entity subscriptions).
 */
export function connectToGateway(config: GatewayConnectionConfig): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(config.url);

        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: 'init',
                workspaceId: config.workspaceId,
                channels: config.channels,
                clientId: config.clientId,
                authToken: config.authToken || undefined,
            }));
        };

        ws.onmessage = (event: MessageEvent) => {
            const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
            if (msg.type === 'ready') {
                // Set the permanent message handler before resolving
                ws.onmessage = (e: MessageEvent) => {
                    const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
                    config.onMessage(m);
                };
                config.onReady?.();
                resolve(ws);
            } else if (msg.type === 'error') {
                reject(new Error(msg.message));
            }
        };

        ws.onerror = () => reject(new Error('Gateway connection failed'));
        ws.onclose = () => config.onClose?.();
    });
}
```

- [ ] **Step 2: Refactor entity-client.ts to use factory**

Replace the `getGateway()` function's inline WebSocket lifecycle with `connectToGateway`. The entity-specific message routing (`entity-state` dispatch to `gwEntityHandlers`) becomes the `onMessage` callback.

- [ ] **Step 3: Refactor data-worker.js to use factory**

The worker can't import TypeScript directly, but since `gateway-connection.ts` is pure browser-compatible code (no Node APIs, no framework deps), the Vite bundler will resolve it. Import it in the worker:

```javascript
import { connectToGateway } from '../gateway-connection.js';
```

Replace the inline WebSocket open/init/ready/onmessage setup in `connectGateway()` with a `connectToGateway()` call. The `handleGatewayMessage` function becomes the `onMessage` callback.

- [ ] **Step 4: Typecheck + test**

Run: `cd packages/client && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(client): extract shared gateway connection factory"
```

---

## Summary

| Task | What | Lines saved (est.) |
|------|------|-------------------|
| 1 | Shared RPC proxy | ~120 lines removed from actors.ts + serve.ts |
| 2 | Semantic gateway protocol | ~10 lines changed, eliminates NATS subject parsing |
| 3 | Shared gateway connection | ~60 lines removed from entity-client.ts + data-worker.js |

**Total: 3 tasks, ~17 steps, ~190 lines of duplication eliminated.**

Tasks 1 and 2 are independent. Task 3 is independent of both. All can be done in any order.
