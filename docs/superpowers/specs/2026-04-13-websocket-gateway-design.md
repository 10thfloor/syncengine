# WebSocket Gateway Design

**Date**: 2026-04-13
**Status**: Draft
**Scope**: Server-side gateway that replaces direct browser-to-NATS connections with an interest-filtered WebSocket bridge.

---

## Problem

Every browser tab opens its own `nats.ws` WebSocket to NATS and creates its own JetStream pull consumers. With N tabs/users on a workspace:

- **N JetStream consumers per channel** — each is a server-side resource on NATS (ordered pull consumer with 5-min inactive timeout).
- **N copies of every delta** — NATS delivers the same message N times.
- **No filtering** — a tab viewing only the Checkout tab for "headphones" still receives every delta for every product across every channel.
- **NATS exposed to the internet** — the browser needs a direct WebSocket URL to NATS, requiring public port exposure, separate TLS, and no auth gating.

There are two NATS connections per tab today: `data-worker.js` (JetStream consumers, entity-writes, authority, topics, GC) and `entity-client.ts` (entity state subscriptions via NATS core). Both connect to `natsUrl` from `virtual:syncengine/runtime-config`.

## Solution

A server-side WebSocket gateway that:

1. Maintains **one** set of NATS subscriptions per workspace (shared across all clients).
2. Tracks per-connection **interest sets** (channels, entity keys, topic keys).
3. Forwards only matching messages to each client.
4. Accepts client publishes and forwards them to NATS.
5. Provides catchup replay from a per-channel ring buffer so new clients don't need their own JetStream consumer.

---

## Architecture

```
                         NATS (:4222)
                           |
              +------------+------------+
              |        Gateway          |
              |                         |
              |  Per-workspace bridge:  |
              |    1 JetStream consumer |
              |      per channel        |
              |    1 sub: entity.>      |
              |    1 sub: entity-writes |
              |    1 sub: authority.>   |
              |    1 sub: topic.>       |
              |    1 sub: gc            |
              |                         |
              |  Per-connection session: |
              |    interest sets        |
              |    lastSeq per channel  |
              +---+-----+-----+--------+
                  |     |     |
               WS/1  WS/2  WS/N   (plain WebSocket, JSON)
```

### Deployment modes

| Mode | How it runs | Port | NATS visibility |
|------|-------------|------|-----------------|
| **Dev** (`syncengine dev`) | Standalone Node process, step 3.5 in boot sequence | `:9333` (new port) | NATS stays internal, browser connects to gateway |
| **Prod** (`syncengine start`) | Embedded in `serve.ts` via HTTP upgrade on the existing `:3000` server | Same port as HTTP | NATS never exposed |
| **Dev escape hatch** | `syncengine dev --raw-nats` | N/A | Browser connects directly to NATS (current behavior) |

---

## Protocol

The gateway speaks JSON over a plain WebSocket (not `nats.ws`). Message types:

### Client -> Gateway

```typescript
// Lifecycle
| { type: 'init'; workspaceId: string; channels: string[]; authToken?: string; clientId: string }

// Interest registration
| { type: 'subscribe';   kind: 'channel';  name: string; lastSeq?: number }
| { type: 'subscribe';   kind: 'entity';   entity: string; key: string }
| { type: 'subscribe';   kind: 'topic';    name: string; key: string }
| { type: 'unsubscribe'; kind: 'channel';  name: string }
| { type: 'unsubscribe'; kind: 'entity';   entity: string; key: string }
| { type: 'unsubscribe'; kind: 'topic';    name: string; key: string }

// Publishing (client -> NATS via gateway)
| { type: 'publish'; kind: 'delta';   subject: string; payload: object }
| { type: 'publish'; kind: 'topic';   subject: string; payload: object }
| { type: 'publish'; kind: 'authority'; viewName: string; deltas: object[] }
```

### Gateway -> Client

```typescript
// Lifecycle
| { type: 'ready' }
| { type: 'error'; message: string; code?: string }

// Forwarded messages (same payload shape as raw NATS messages today)
| { type: 'delta';         channel: string; seq: number; payload: object }
| { type: 'entity-write';  payload: object; seq: number }
| { type: 'entity-state';  entity: string; key: string; payload: object }
| { type: 'authority';     viewName: string; payload: object }
| { type: 'topic';         name: string; key: string; payload: object }
| { type: 'gc';            payload: object }

// Replay boundary marker
| { type: 'replay-end'; channel: string }
```

### Init handshake

1. Client opens WebSocket to gateway URL.
2. Client sends `init` with `workspaceId`, `channels` (the channel names from the client's schema), `clientId`, and optional `authToken`.
3. Gateway validates, attaches connection to the workspace bridge (creating one if first client for that workspace). The bridge uses `channels` to lazily create JetStream consumers for any channels it hasn't seen yet.
4. Gateway sends `ready`.
5. Client sends `subscribe` messages for its initial interest set.

### Self-echo suppression

Deltas published by a client carry `_clientId`. The gateway checks the `_clientId` of incoming NATS messages against the publishing session's `clientId` and suppresses echo delivery. This matches the current self-filter in `data-worker.js` line 440 (`msg._clientId === CLIENT_ID`), but moves it server-side.

---

## Workspace Bridge

One `WorkspaceBridge` instance per workspace, created lazily on the first `init` for that `workspaceId`. Torn down when the last session disconnects (with a 30-second grace period for reconnects).

### NATS subscriptions

The bridge opens these against the NATS server (not nats.ws — server-side `nats` package):

| Subject pattern | Type | Purpose |
|----------------|------|---------|
| `ws.{wsId}.ch.{name}.deltas` (per channel) | JetStream ordered pull consumer | Channel deltas |
| `ws.{wsId}.entity-writes` | JetStream ordered pull consumer | Entity emit() inserts |
| `ws.{wsId}.entity.>` | Core subscription (wildcard) | Entity state broadcasts |
| `ws.{wsId}.authority.>` | Core subscription (wildcard) | Non-monotonic view updates |
| `ws.{wsId}.topic.>` | Core subscription (wildcard) | Ephemeral topic messages |
| `ws.{wsId}.gc` | Core subscription | GC watermark signals |

The bridge's JetStream consumers use `deliver_policy: 'new'` — they only receive messages published after the bridge starts. The ring buffer fills from the bridge's start time onward. Clients that need older history (deep catchup) trigger a temporary per-client consumer. This avoids replaying the entire stream history on gateway startup.

The bridge discovers which channel subjects exist by reading the stream's subjects from the JetStream stream info API (`stream.info()` returns subject counts). Alternatively, the first client's `subscribe channel` messages lazily create consumers.

### Ring buffer

Per-channel circular buffer holding the last `RING_CAPACITY` messages (default: 10,000) with their JetStream sequence numbers.

```typescript
interface RingEntry {
    seq: number;          // JetStream sequence
    payload: object;      // decoded message
    clientId: string;     // _clientId from message (for self-echo suppression)
}
```

**Catchup strategy** when a new session subscribes to a channel with `lastSeq`:

| Case | Action |
|------|--------|
| `lastSeq` is 0 or absent | Deliver from ring buffer head (current position), no replay |
| `lastSeq` is within ring buffer range | Replay from `lastSeq + 1` through ring head, then live |
| `lastSeq` is older than ring buffer's oldest entry | Create a temporary one-shot JetStream consumer starting at `lastSeq + 1`, replay until caught up to ring head, then switch to shared live path. Temporary consumer is deleted after catchup. |

After replay, gateway sends `{ type: 'replay-end', channel }` so the client knows the boundary.

### Session routing

On each NATS message, the bridge iterates its connected sessions and forwards to those whose interest set matches:

```
onChannelDelta(channel, msg, seq):
    for session of sessions:
        if session.channels.has(channel) AND msg._clientId !== session.clientId:
            session.send({ type: 'delta', channel, seq, payload: msg })

onEntityState(entityName, entityKey, msg):
    matchKey = `${entityName}:${entityKey}`
    for session of sessions:
        if session.entities.has(matchKey):
            session.send({ type: 'entity-state', entity: entityName, key: entityKey, payload: msg })

onTopic(topicName, topicKey, msg):
    matchKey = `${topicName}:${topicKey}`
    for session of sessions:
        if session.topics.has(matchKey):
            session.send({ type: 'topic', name: topicName, key: topicKey, payload: msg })

onAuthority(viewName, msg):
    // Authority updates go to all sessions that subscribe to any channel
    // (the client's DBSP engine needs them regardless of view-to-channel mapping,
    // since view dependencies are resolved client-side)
    for session of sessions:
        if session.channels.size > 0:
            session.send({ type: 'authority', viewName, payload: msg })

onGC(msg):
    for session of sessions:
        session.send({ type: 'gc', payload: msg })

onEntityWrite(msg, seq):
    // Entity-writes go to all sessions (they feed client-side DBSP)
    for session of sessions:
        if msg._clientId !== session.clientId:
            session.send({ type: 'entity-write', payload: msg, seq })
```

### Publishing (client -> NATS)

When a session sends a `publish` message:

- `kind: 'delta'` — gateway publishes to the specified NATS subject.
- `kind: 'topic'` — gateway publishes to the specified NATS subject. Additionally, the gateway locally routes the message to other interested sessions (local echo) without waiting for the NATS round-trip, since topics are ephemeral and low-latency matters.
- `kind: 'authority'` — gateway POSTs to Restate's authority endpoint (same as the current client-side `sendToAuthority` in data-worker.js). The gateway has the Restate URL; the client no longer needs it.

### Peer ack (GC)

The gateway handles peer ack reporting on behalf of its sessions. Every 5 minutes (matching `PEER_ACK_INTERVAL_MS`), the gateway reports to Restate's `reportPeerSeq` endpoint with the minimum `lastSeq` across all sessions for the workspace. This replaces per-client reporting — one report per gateway instead of N.

---

## Client Transport Changes

### data-worker.js

The existing `connectNats()` function (line 496) is the single point of change. A new `connectGateway()` function replaces it when the `natsUrl` points to the gateway.

**Detection**: If the URL contains a path component `/gateway` (e.g., `ws://localhost:9333/gateway`), use gateway transport. Otherwise fall back to direct NATS (escape hatch). The runtime config controls this — no code-level flag needed.

**connectGateway()** replaces:
- `nats.ws` import and `connect()` -> plain `new WebSocket(url)`
- JetStream consumer creation -> `subscribe` messages to gateway
- Core subscriptions -> `subscribe` messages to gateway
- `nats.conn.publish()` -> `publish` messages to gateway
- `codec.encode/decode` -> `JSON.stringify/JSON.parse` (already JSON, just no NATS framing)
- Self-echo filtering -> removed (gateway handles it)
- Authority `fetch()` calls -> `publish kind: 'authority'` to gateway
- `reportPeerSeq` timer -> removed (gateway handles it)
- Consumer cleanup on disconnect -> removed (gateway handles it)

**What stays the same**:
- The `processConsumer` message handling pipeline (dedup, DBSP ingestion, view updates)
- Replay coordination (`sync.isReplaying`, `markConsumerCaughtUp`, `finalizeReplay`)
- SQLite operations
- All `self.postMessage` calls to the main thread
- Topic state management (`topicState.desired`, `topicState.subs`)

The replay boundary is now signaled by the gateway's `replay-end` message instead of JetStream's `info.num_pending === 0`.

### entity-client.ts

The entity client (line 150) currently opens its own lazy NATS connection for entity state subscriptions. With the gateway:

- Replace `nats.ws` connection with a shared gateway WebSocket (can be the same connection as the data-worker's, or a second one — second is simpler, same as today's two-connection model).
- Replace `nc.subscribe(subject)` with a `subscribe kind: 'entity'` message.
- Replace the `for await (const msg of natsSub)` loop with a `ws.onmessage` handler filtered to `type: 'entity-state'` messages matching the entity/key.
- Replace `nc.publish()` for entity state -> not needed (entity-client uses HTTP POST to Restate for handler calls, not NATS publish).

### runtime-config.d.ts

Add a `gatewayUrl` field alongside `natsUrl`:

```typescript
declare module 'virtual:syncengine/runtime-config' {
    export const workspaceId: string;
    export const natsUrl: string;       // kept for --raw-nats escape hatch
    export const gatewayUrl: string;    // new: gateway WebSocket URL
    export const restateUrl: string;
    export const authToken: string | null;
}
```

The client checks `gatewayUrl` first; if present, uses gateway transport. Falls back to `natsUrl` for direct NATS.

---

## Dev Integration (cli/dev.ts)

### New port

Add `gateway: 9333` to `DEFAULT_PORTS` in `state.ts`.

### Boot sequence

Insert between step 3 (workspace service) and step 5 (runtime.json):

```
3.   Workspace service (:9080) — wait for TCP
3.5  Gateway (:9333) — spawn, wait for HTTP /healthz
4.   Register deployment with Restate (unchanged)
5.   Write runtime.json — now includes gatewayUrl
6.   Vite (:5173)
```

The gateway is spawned as a standalone Node process running `packages/server/src/gateway/standalone.ts`. It reads:
- `NATS_URL` — internal NATS client URL (`nats://127.0.0.1:4222`)
- `PORT` — gateway listen port (9333)
- `SYNCENGINE_RESTATE_URL` — Restate ingress for authority proxying

### runtime.json change

```json
{
    "natsUrl": "ws://localhost:9222",
    "gatewayUrl": "ws://localhost:9333/gateway",
    "restateUrl": "http://localhost:8080",
    "authToken": null
}
```

### --raw-nats flag

When `syncengine dev --raw-nats` is passed:
- Skip spawning the gateway process.
- Omit `gatewayUrl` from runtime.json.
- Client falls back to direct NATS via `natsUrl` (current behavior).

---

## Production Integration (serve.ts)

### WebSocket upgrade

`serve.ts` already runs a plain `http.createServer`. Add a `'upgrade'` handler for WebSocket connections on path `/gateway`:

```typescript
server.on('upgrade', (req, socket, head) => {
    if (req.url === '/gateway') {
        gateway.handleUpgrade(req, socket, head);
    } else {
        socket.destroy();
    }
});
```

This means the production server handles HTTP requests and WebSocket connections on the same port (`:3000`). The browser connects to `ws://hostname:3000/gateway` — same origin, standard TLS termination, no CORS.

### Meta tag injection

The `natsUrl` meta tag injected into `index.html` becomes `gatewayUrl`:

```html
<meta name="syncengine-gateway-url" content="ws://localhost:3000/gateway">
```

The vite-plugin reads this and populates `virtual:syncengine/runtime-config`.

---

## File Plan

### New files

| File | Purpose |
|------|---------|
| `packages/server/src/gateway/protocol.ts` | TypeScript types for the client-gateway protocol |
| `packages/server/src/gateway/ring-buffer.ts` | Per-channel bounded circular buffer |
| `packages/server/src/gateway/workspace-bridge.ts` | Per-workspace NATS subscription manager + session routing |
| `packages/server/src/gateway/client-session.ts` | Per-WebSocket-connection state + interest sets |
| `packages/server/src/gateway/server.ts` | WebSocket server, upgrade handling, bridge lifecycle |
| `packages/server/src/gateway/index.ts` | Public API re-exports |
| `packages/server/src/gateway/standalone.ts` | Standalone entry point for `syncengine dev` |

### Modified files

| File | Change |
|------|--------|
| `packages/server/package.json` | Add `ws` dependency |
| `packages/client/src/workers/data-worker.js` | Add `connectGateway()` alongside existing `connectNats()` |
| `packages/client/src/entity-client.ts` | Add gateway transport for entity subscriptions |
| `packages/client/src/runtime-config.d.ts` | Add `gatewayUrl` export |
| `packages/client/src/store.ts` | Pass `gatewayUrl` to worker init message |
| `packages/cli/src/state.ts` | Add `gateway` port to `Ports` and `DEFAULT_PORTS` |
| `packages/cli/src/dev.ts` | Spawn gateway process, add `--raw-nats` flag |
| `packages/server/src/serve.ts` | Add WebSocket upgrade handler, embed gateway |

---

## Performance Characteristics

### Filtering cost

Interest check is `Set.has()` — O(1) per session per message. With 1000 sessions and 1000 deltas/sec, that's 1M hash lookups/sec. A single Node.js event loop handles this trivially.

### Memory

- Ring buffer: 10K entries * ~1 KB avg payload = ~10 MB per channel per workspace.
- Session state: ~200 bytes per session (3 Sets + metadata).
- WebSocket buffers: managed by `ws` library, ~64 KB per connection.
- For 1000 sessions on a workspace with 2 channels: ~20 MB ring + ~0.2 MB sessions + ~64 MB WS = ~85 MB total.

### Latency

The gateway adds one hop: NATS -> gateway process -> WebSocket to client. On localhost this is < 0.5ms. In production (same machine/container), < 1ms. The interest check adds ~0.001ms per session.

### Bandwidth savings

Example: 200 clients, 2 channels, CheckoutTab active on 50 clients (each viewing 1 of 6 products):
- **Before**: 200 * 2 = 400 delta deliveries per message.
- **After**: 50 deliveries (only to interested clients) for product-scoped deltas. 200 for entity-writes (broadcast). Net: ~60-75% bandwidth reduction depending on message mix.

---

## Testing Strategy

### Unit tests

- `ring-buffer.ts`: insert, wrap-around, range queries, overflow behavior.
- `workspace-bridge.ts`: mock NATS connection, verify routing logic (interest match, self-echo suppression, entity wildcard parsing).
- `client-session.ts`: subscribe/unsubscribe, interest set management.

### Integration tests

- Spin up NATS (in-process or test container), create a bridge, connect two mock sessions with different interests. Publish deltas, verify each session receives only matching messages.
- Catchup replay: connect a session with `lastSeq` within ring buffer range, verify it receives historical messages followed by `replay-end`, then live messages.
- Deep catchup: connect a session with `lastSeq` older than ring buffer, verify temporary consumer is created and deleted after catchup.

### E2E tests

- `syncengine dev` with gateway: open two browser tabs with different users, verify live sync works identically to direct NATS.
- `syncengine dev --raw-nats`: verify fallback to direct NATS.

---

## Non-goals (deferred)

- **Server-side view materialization** — the gateway filters raw deltas; it does not compute views. That's the tiered materialization solution (separate feature).
- **Subject partitioning** — the gateway makes this unnecessary for the 100-1000 client range. Can be added later for NATS-level efficiency at extreme scale.
- **Auth** — the gateway accepts an `authToken` in the init message but does not validate it yet. Auth is a separate concern.
- **Horizontal gateway scaling** — a single gateway process per workspace is sufficient for the target scale. Sharding across gateway instances (route by workspace) is a future concern.
- **Compression** — WebSocket permessage-deflate can be enabled on the `ws` server config, but is not part of this design. Easy to add later.
