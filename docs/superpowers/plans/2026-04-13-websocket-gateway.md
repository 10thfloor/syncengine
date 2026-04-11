# WebSocket Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct browser-to-NATS connections with a server-side WebSocket gateway that shares one set of NATS subscriptions per workspace and filters messages by per-client interest sets.

**Architecture:** A `WorkspaceBridge` manages one NATS connection per workspace (JetStream consumers + core subscriptions). Each browser WebSocket maps to a `ClientSession` with interest sets (channels, entities, topics). The bridge routes incoming NATS messages to matching sessions. A per-channel `RingBuffer` enables catchup replay without per-client JetStream consumers.

**Tech Stack:** Node.js, `ws` (WebSocket server), `nats` (server-side NATS client), TypeScript.

**Spec:** `docs/superpowers/specs/2026-04-13-websocket-gateway-design.md`

---

## File Structure

### New files (packages/server/src/gateway/)

| File | Responsibility |
|------|---------------|
| `protocol.ts` | TypeScript types for every client-gateway message |
| `ring-buffer.ts` | Bounded circular buffer with seq-range queries |
| `client-session.ts` | Per-WebSocket interest sets + send helper |
| `workspace-bridge.ts` | Per-workspace NATS subscriptions + message routing to sessions |
| `server.ts` | WebSocket server, upgrade handling, bridge lifecycle |
| `standalone.ts` | Entry point for `syncengine dev` (spawns HTTP server with /healthz + WS upgrade) |
| `index.ts` | Re-exports for public API |

### Modified files

| File | What changes |
|------|-------------|
| `packages/server/package.json` | Add `ws` + `@types/ws` deps |
| `packages/core/src/http.ts` | Add `gatewayUrl` to `injectMetaTags` values |
| `packages/client/src/runtime-config.d.ts` | Add `gatewayUrl` export |
| `packages/vite-plugin/src/index.ts` | Emit `gatewayUrl` in virtual module |
| `packages/vite-plugin/src/workspaces.ts` | Pass `gatewayUrl` through meta tag injection |
| `packages/client/src/store.ts` | Pass `gatewayUrl` in SyncConfig to worker |
| `packages/client/src/workers/data-worker.js` | Add `connectGateway()` transport |
| `packages/client/src/entity-client.ts` | Add gateway transport for entity subs |
| `packages/cli/src/state.ts` | Add `gateway` port |
| `packages/cli/src/dev.ts` | Spawn gateway process, `--raw-nats` flag |
| `packages/server/src/serve.ts` | Embed gateway via WS upgrade |

---

### Task 1: Protocol Types

**Files:**
- Create: `packages/server/src/gateway/protocol.ts`

- [ ] **Step 1: Create protocol.ts with all message types**

```typescript
// packages/server/src/gateway/protocol.ts

// ── Client -> Gateway ────────────────────────────────────────────────────────

export interface InitMsg {
    type: 'init';
    workspaceId: string;
    channels: string[];
    clientId: string;
    authToken?: string;
}

export interface SubscribeChannelMsg {
    type: 'subscribe';
    kind: 'channel';
    name: string;
    lastSeq?: number;
}

export interface SubscribeEntityMsg {
    type: 'subscribe';
    kind: 'entity';
    entity: string;
    key: string;
}

export interface SubscribeTopicMsg {
    type: 'subscribe';
    kind: 'topic';
    name: string;
    key: string;
}

export interface UnsubscribeChannelMsg {
    type: 'unsubscribe';
    kind: 'channel';
    name: string;
}

export interface UnsubscribeEntityMsg {
    type: 'unsubscribe';
    kind: 'entity';
    entity: string;
    key: string;
}

export interface UnsubscribeTopicMsg {
    type: 'unsubscribe';
    kind: 'topic';
    name: string;
    key: string;
}

export interface PublishDeltaMsg {
    type: 'publish';
    kind: 'delta';
    subject: string;
    payload: Record<string, unknown>;
}

export interface PublishTopicMsg {
    type: 'publish';
    kind: 'topic';
    subject: string;
    payload: Record<string, unknown>;
}

export interface PublishAuthorityMsg {
    type: 'publish';
    kind: 'authority';
    viewName: string;
    deltas: Record<string, unknown>[];
}

export type ClientMsg =
    | InitMsg
    | SubscribeChannelMsg | SubscribeEntityMsg | SubscribeTopicMsg
    | UnsubscribeChannelMsg | UnsubscribeEntityMsg | UnsubscribeTopicMsg
    | PublishDeltaMsg | PublishTopicMsg | PublishAuthorityMsg;

// ── Gateway -> Client ────────────────────────────────────────────────────────

export interface ReadyMsg {
    type: 'ready';
}

export interface ErrorMsg {
    type: 'error';
    message: string;
    code?: string;
}

export interface DeltaMsg {
    type: 'delta';
    channel: string;
    seq: number;
    payload: Record<string, unknown>;
}

export interface EntityWriteMsg {
    type: 'entity-write';
    seq: number;
    payload: Record<string, unknown>;
}

export interface EntityStateMsg {
    type: 'entity-state';
    entity: string;
    key: string;
    payload: Record<string, unknown>;
}

export interface AuthorityMsg {
    type: 'authority';
    viewName: string;
    payload: Record<string, unknown>;
}

export interface TopicOutMsg {
    type: 'topic';
    name: string;
    key: string;
    payload: Record<string, unknown>;
}

export interface GCMsg {
    type: 'gc';
    payload: Record<string, unknown>;
}

export interface ReplayEndMsg {
    type: 'replay-end';
    channel: string;
}

export type ServerMsg =
    | ReadyMsg | ErrorMsg
    | DeltaMsg | EntityWriteMsg | EntityStateMsg
    | AuthorityMsg | TopicOutMsg | GCMsg
    | ReplayEndMsg;
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/gateway/protocol.ts
git commit -m "feat(gateway): add protocol message types"
```

---

### Task 2: Ring Buffer

**Files:**
- Create: `packages/server/src/gateway/ring-buffer.ts`
- Create: `packages/server/src/gateway/__tests__/ring-buffer.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/server/src/gateway/__tests__/ring-buffer.test.ts
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../ring-buffer.js';

describe('RingBuffer', () => {
    it('stores and retrieves entries', () => {
        const ring = new RingBuffer(5);
        ring.push(1, { data: 'a' }, 'c1');
        ring.push(2, { data: 'b' }, 'c2');

        const entries = ring.rangeFrom(1);
        expect(entries).toHaveLength(2);
        expect(entries[0]!.seq).toBe(1);
        expect(entries[1]!.seq).toBe(2);
    });

    it('rangeFrom returns entries after the given seq', () => {
        const ring = new RingBuffer(10);
        ring.push(10, { x: 1 }, 'c1');
        ring.push(11, { x: 2 }, 'c1');
        ring.push(12, { x: 3 }, 'c1');

        const entries = ring.rangeFrom(11);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.seq).toBe(12);
    });

    it('wraps around when capacity is exceeded', () => {
        const ring = new RingBuffer(3);
        ring.push(1, { a: 1 }, 'c1');
        ring.push(2, { a: 2 }, 'c1');
        ring.push(3, { a: 3 }, 'c1');
        ring.push(4, { a: 4 }, 'c1'); // overwrites seq 1

        expect(ring.oldestSeq()).toBe(2);
        expect(ring.newestSeq()).toBe(4);
        expect(ring.rangeFrom(0)).toHaveLength(3);
        expect(ring.rangeFrom(0)[0]!.seq).toBe(2);
    });

    it('containsSeq returns true for seqs in range', () => {
        const ring = new RingBuffer(5);
        ring.push(10, {}, 'c1');
        ring.push(11, {}, 'c1');
        ring.push(12, {}, 'c1');

        expect(ring.containsSeq(10)).toBe(true);
        expect(ring.containsSeq(12)).toBe(true);
        expect(ring.containsSeq(9)).toBe(false);
        expect(ring.containsSeq(13)).toBe(false);
    });

    it('returns empty array when empty', () => {
        const ring = new RingBuffer(5);
        expect(ring.rangeFrom(0)).toEqual([]);
        expect(ring.oldestSeq()).toBe(-1);
        expect(ring.newestSeq()).toBe(-1);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/gateway/__tests__/ring-buffer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement RingBuffer**

```typescript
// packages/server/src/gateway/ring-buffer.ts

export interface RingEntry {
    seq: number;
    payload: Record<string, unknown>;
    clientId: string;
}

const RING_CAPACITY_DEFAULT = 10_000;

export class RingBuffer {
    private readonly buf: (RingEntry | null)[];
    private readonly cap: number;
    private head = 0; // next write index
    private size = 0;

    constructor(capacity: number = RING_CAPACITY_DEFAULT) {
        this.cap = capacity;
        this.buf = new Array(capacity).fill(null);
    }

    push(seq: number, payload: Record<string, unknown>, clientId: string): void {
        this.buf[this.head] = { seq, payload, clientId };
        this.head = (this.head + 1) % this.cap;
        if (this.size < this.cap) this.size++;
    }

    /** Oldest seq in the buffer, or -1 if empty. */
    oldestSeq(): number {
        if (this.size === 0) return -1;
        const idx = this.size < this.cap ? 0 : this.head;
        return this.buf[idx]!.seq;
    }

    /** Newest seq in the buffer, or -1 if empty. */
    newestSeq(): number {
        if (this.size === 0) return -1;
        const idx = (this.head - 1 + this.cap) % this.cap;
        return this.buf[idx]!.seq;
    }

    /** Whether the given seq is within the buffer's current range. */
    containsSeq(seq: number): boolean {
        if (this.size === 0) return false;
        return seq >= this.oldestSeq() && seq <= this.newestSeq();
    }

    /**
     * Return all entries with seq > afterSeq, in order.
     * If afterSeq is 0 or before the oldest entry, returns everything.
     */
    rangeFrom(afterSeq: number): RingEntry[] {
        if (this.size === 0) return [];

        const result: RingEntry[] = [];
        const start = this.size < this.cap ? 0 : this.head;
        for (let i = 0; i < this.size; i++) {
            const entry = this.buf[(start + i) % this.cap]!;
            if (entry.seq > afterSeq) {
                result.push(entry);
            }
        }
        return result;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/gateway/__tests__/ring-buffer.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/gateway/ring-buffer.ts packages/server/src/gateway/__tests__/ring-buffer.test.ts
git commit -m "feat(gateway): add RingBuffer with tests"
```

---

### Task 3: Client Session

**Files:**
- Create: `packages/server/src/gateway/client-session.ts`
- Create: `packages/server/src/gateway/__tests__/client-session.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/server/src/gateway/__tests__/client-session.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ClientSession } from '../client-session.js';

function mockWs() {
    return {
        send: vi.fn(),
        readyState: 1, // WebSocket.OPEN
        OPEN: 1,
    } as any;
}

describe('ClientSession', () => {
    it('tracks channel subscriptions', () => {
        const session = new ClientSession('client-1', mockWs());
        session.subscribeChannel('ledger');
        expect(session.channels.has('ledger')).toBe(true);
        session.unsubscribeChannel('ledger');
        expect(session.channels.has('ledger')).toBe(false);
    });

    it('tracks entity subscriptions', () => {
        const session = new ClientSession('client-1', mockWs());
        session.subscribeEntity('inventory', 'headphones');
        expect(session.entities.has('inventory:headphones')).toBe(true);
        session.unsubscribeEntity('inventory', 'headphones');
        expect(session.entities.has('inventory:headphones')).toBe(false);
    });

    it('tracks topic subscriptions', () => {
        const session = new ClientSession('client-1', mockWs());
        session.subscribeTopic('cursors', 'global');
        expect(session.topics.has('cursors:global')).toBe(true);
        session.unsubscribeTopic('cursors', 'global');
        expect(session.topics.has('cursors:global')).toBe(false);
    });

    it('send() serializes and writes to WebSocket', () => {
        const ws = mockWs();
        const session = new ClientSession('client-1', ws);
        session.send({ type: 'ready' });
        expect(ws.send).toHaveBeenCalledWith('{"type":"ready"}');
    });

    it('send() skips when WebSocket is not open', () => {
        const ws = mockWs();
        ws.readyState = 3; // CLOSED
        const session = new ClientSession('client-1', ws);
        session.send({ type: 'ready' });
        expect(ws.send).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/gateway/__tests__/client-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ClientSession**

```typescript
// packages/server/src/gateway/client-session.ts
import type { ServerMsg } from './protocol.js';

export class ClientSession {
    readonly clientId: string;
    readonly channels = new Set<string>();
    readonly entities = new Set<string>();
    readonly topics = new Set<string>();
    /** Per-channel highest seq delivered to this session. */
    readonly channelSeqs = new Map<string, number>();

    private readonly ws: { send(data: string): void; readyState: number; OPEN: number };

    constructor(clientId: string, ws: { send(data: string): void; readyState: number; OPEN: number }) {
        this.clientId = clientId;
        this.ws = ws;
    }

    subscribeChannel(name: string): void { this.channels.add(name); }
    unsubscribeChannel(name: string): void { this.channels.delete(name); }

    subscribeEntity(entity: string, key: string): void { this.entities.add(`${entity}:${key}`); }
    unsubscribeEntity(entity: string, key: string): void { this.entities.delete(`${entity}:${key}`); }

    subscribeTopic(name: string, key: string): void { this.topics.add(`${name}:${key}`); }
    unsubscribeTopic(name: string, key: string): void { this.topics.delete(`${name}:${key}`); }

    send(msg: ServerMsg): void {
        if (this.ws.readyState !== this.ws.OPEN) return;
        this.ws.send(JSON.stringify(msg));
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/gateway/__tests__/client-session.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/gateway/client-session.ts packages/server/src/gateway/__tests__/client-session.test.ts
git commit -m "feat(gateway): add ClientSession with interest tracking"
```

---

### Task 4: Workspace Bridge

**Files:**
- Create: `packages/server/src/gateway/workspace-bridge.ts`

This is the core routing logic. It manages one NATS connection per workspace and dispatches messages to matching sessions.

- [ ] **Step 1: Install `ws` dependency**

Run: `cd packages/server && pnpm add ws && pnpm add -D @types/ws`

- [ ] **Step 2: Create workspace-bridge.ts**

```typescript
// packages/server/src/gateway/workspace-bridge.ts
import {
    connect,
    JSONCodec,
    type NatsConnection,
    type JetStreamClient,
    type Subscription,
} from 'nats';
import { RingBuffer } from './ring-buffer.js';
import { ClientSession } from './client-session.js';
import type { ServerMsg } from './protocol.js';

const PEER_ACK_INTERVAL_MS = 5 * 60_000;
const TEARDOWN_GRACE_MS = 30_000;

export interface BridgeConfig {
    natsUrl: string;
    restateUrl: string;
    workspaceId: string;
}

export class WorkspaceBridge {
    readonly workspaceId: string;
    private readonly natsUrl: string;
    private readonly restateUrl: string;
    private nc: NatsConnection | null = null;
    private js: JetStreamClient | null = null;
    private readonly codec = JSONCodec();

    private readonly sessions = new Set<ClientSession>();
    private readonly channelRings = new Map<string, RingBuffer>();
    private readonly channelConsumers = new Map<string, { stop(): void }>();
    private readonly coreSubs: Subscription[] = [];
    private peerAckTimer: ReturnType<typeof setInterval> | null = null;
    private teardownTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;

    /** Callback invoked when the bridge has zero sessions and the grace period expires. */
    onEmpty: (() => void) | null = null;

    constructor(config: BridgeConfig) {
        this.workspaceId = config.workspaceId;
        this.natsUrl = config.natsUrl;
        this.restateUrl = config.restateUrl;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    async start(): Promise<void> {
        this.nc = await connect({ servers: this.natsUrl });
        this.js = this.nc.jetstream();

        const wsId = this.workspaceId;

        // Core subscriptions (wildcard)
        this.subscribeCoreSubject(`ws.${wsId}.entity.>`, this.onEntityMessage.bind(this));
        this.subscribeCoreSubject(`ws.${wsId}.authority.>`, this.onAuthorityMessage.bind(this));
        this.subscribeCoreSubject(`ws.${wsId}.topic.>`, this.onTopicMessage.bind(this));
        this.subscribeCoreSubject(`ws.${wsId}.gc`, this.onGCMessage.bind(this));

        // Peer ack timer (reports minimum seq across all sessions)
        this.peerAckTimer = setInterval(() => this.reportPeerAck(), PEER_ACK_INTERVAL_MS);
    }

    async stop(): Promise<void> {
        this.closed = true;
        if (this.peerAckTimer) clearInterval(this.peerAckTimer);
        if (this.teardownTimer) clearTimeout(this.teardownTimer);
        for (const sub of this.coreSubs) sub.unsubscribe();
        for (const [, consumer] of this.channelConsumers) consumer.stop();
        this.channelConsumers.clear();
        if (this.nc && !this.nc.isClosed()) await this.nc.drain();
    }

    // ── Session management ───────────────────────────────────────────────

    addSession(session: ClientSession): void {
        if (this.teardownTimer) {
            clearTimeout(this.teardownTimer);
            this.teardownTimer = null;
        }
        this.sessions.add(session);
    }

    removeSession(session: ClientSession): void {
        this.sessions.delete(session);
        if (this.sessions.size === 0 && !this.closed) {
            this.teardownTimer = setTimeout(() => {
                if (this.sessions.size === 0) this.onEmpty?.();
            }, TEARDOWN_GRACE_MS);
        }
    }

    get sessionCount(): number { return this.sessions.size; }

    // ── Channel consumers (lazy, created on first subscribe) ─────────────

    async ensureChannelConsumer(channelName: string): Promise<void> {
        if (this.channelConsumers.has(channelName)) return;
        if (!this.js || !this.nc || this.closed) return;

        const subject = `ws.${this.workspaceId}.ch.${channelName}.deltas`;
        const streamName = `WS_${this.workspaceId.replace(/-/g, '_')}`;
        const ring = new RingBuffer();
        this.channelRings.set(channelName, ring);

        try {
            const consumer = await this.js.consumers.get(streamName, {
                filterSubjects: [subject],
                deliver_policy: 'new',
            });
            const messages = await consumer.consume();
            const tracker = { stopped: false, stop() { this.stopped = true; messages.stop(); } };
            this.channelConsumers.set(channelName, tracker);

            (async () => {
                for await (const raw of messages) {
                    if (tracker.stopped) break;
                    try {
                        const payload = this.codec.decode(raw.data) as Record<string, unknown>;
                        const seq = raw.seq;
                        const msgClientId = (payload._clientId as string) ?? '';

                        ring.push(seq, payload, msgClientId);

                        for (const session of this.sessions) {
                            if (!session.channels.has(channelName)) continue;
                            if (msgClientId === session.clientId) continue;
                            session.send({ type: 'delta', channel: channelName, seq, payload });
                            session.channelSeqs.set(channelName, seq);
                        }
                    } catch { /* decode error — skip */ }
                    raw.ack();
                }
            })().catch((err) => {
                if (!tracker.stopped) console.error(`[gateway] channel consumer ${channelName}:`, err);
            });
        } catch (err) {
            console.warn(`[gateway] failed to create consumer for channel ${channelName}:`, err);
        }
    }

    /** Also set up entity-writes consumer (JetStream, broadcast to all). */
    async ensureEntityWritesConsumer(): Promise<void> {
        const key = '__entity-writes__';
        if (this.channelConsumers.has(key)) return;
        if (!this.js || !this.nc || this.closed) return;

        const subject = `ws.${this.workspaceId}.entity-writes`;
        const streamName = `WS_${this.workspaceId.replace(/-/g, '_')}`;
        const ring = new RingBuffer();
        this.channelRings.set(key, ring);

        try {
            const consumer = await this.js.consumers.get(streamName, {
                filterSubjects: [subject],
                deliver_policy: 'new',
            });
            const messages = await consumer.consume();
            const tracker = { stopped: false, stop() { this.stopped = true; messages.stop(); } };
            this.channelConsumers.set(key, tracker);

            (async () => {
                for await (const raw of messages) {
                    if (tracker.stopped) break;
                    try {
                        const payload = this.codec.decode(raw.data) as Record<string, unknown>;
                        const seq = raw.seq;
                        const msgClientId = (payload._clientId as string) ?? '';

                        ring.push(seq, payload, msgClientId);

                        for (const session of this.sessions) {
                            if (msgClientId === session.clientId) continue;
                            session.send({ type: 'entity-write', seq, payload });
                        }
                    } catch { /* skip */ }
                    raw.ack();
                }
            })().catch((err) => {
                if (!tracker.stopped) console.error(`[gateway] entity-writes consumer:`, err);
            });
        } catch (err) {
            console.warn(`[gateway] failed to create entity-writes consumer:`, err);
        }
    }

    // ── Catchup replay from ring buffer ──────────────────────────────────

    replayChannel(session: ClientSession, channelName: string, lastSeq: number): void {
        const ring = this.channelRings.get(channelName);
        if (!ring || lastSeq <= 0) {
            session.send({ type: 'replay-end', channel: channelName });
            return;
        }

        const entries = ring.rangeFrom(lastSeq);
        for (const entry of entries) {
            if (entry.clientId === session.clientId) continue;
            session.send({ type: 'delta', channel: channelName, seq: entry.seq, payload: entry.payload });
            session.channelSeqs.set(channelName, entry.seq);
        }
        session.send({ type: 'replay-end', channel: channelName });
    }

    // ── Client publish (outbound) ────────────────────────────────────────

    publishDelta(subject: string, payload: Record<string, unknown>): void {
        if (!this.nc || this.nc.isClosed()) return;
        this.nc.publish(subject, this.codec.encode(payload));
    }

    publishTopicLocal(name: string, key: string, payload: Record<string, unknown>, senderClientId: string): void {
        // Publish to NATS
        const subject = `ws.${this.workspaceId}.topic.${name}.${key}`;
        if (this.nc && !this.nc.isClosed()) {
            this.nc.publish(subject, this.codec.encode(payload));
        }
    }

    async publishAuthority(viewName: string, deltas: Record<string, unknown>[], authToken?: string): Promise<void> {
        const url = `${this.restateUrl}/workspace/${this.workspaceId}/authority`;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (authToken) headers.Authorization = `Bearer ${authToken}`;
        try {
            await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ viewName, deltas }),
            });
        } catch (err) {
            console.warn(`[gateway] authority POST failed:`, err);
        }
    }

    // ── Core subscription helpers ────────────────────────────────────────

    private subscribeCoreSubject(subject: string, handler: (data: Record<string, unknown>, subjectTokens: string[]) => void): void {
        if (!this.nc) return;
        const sub = this.nc.subscribe(subject);
        this.coreSubs.push(sub);
        (async () => {
            for await (const msg of sub) {
                try {
                    const data = this.codec.decode(msg.data) as Record<string, unknown>;
                    handler(data, msg.subject.split('.'));
                } catch { /* decode error — skip */ }
            }
        })().catch(() => { /* sub closed */ });
    }

    // ── Message handlers (NATS -> sessions) ──────────────────────────────

    private onEntityMessage(data: Record<string, unknown>, tokens: string[]): void {
        // Subject: ws.{wsId}.entity.{entityName}.{entityKey}.state
        // tokens:  [ws, wsId, entity, entityName, entityKey, state]
        if (tokens.length < 6) return;
        const entityName = tokens[3]!;
        const entityKey = tokens[4]!;
        const matchKey = `${entityName}:${entityKey}`;

        for (const session of this.sessions) {
            if (session.entities.has(matchKey)) {
                session.send({ type: 'entity-state', entity: entityName, key: entityKey, payload: data });
            }
        }
    }

    private onAuthorityMessage(data: Record<string, unknown>, tokens: string[]): void {
        // Subject: ws.{wsId}.authority.{viewName}
        if (tokens.length < 4) return;
        const viewName = tokens[3]!;

        for (const session of this.sessions) {
            if (session.channels.size > 0) {
                session.send({ type: 'authority', viewName, payload: data });
            }
        }
    }

    private onTopicMessage(data: Record<string, unknown>, tokens: string[]): void {
        // Subject: ws.{wsId}.topic.{topicName}.{topicKey}
        if (tokens.length < 5) return;
        const topicName = tokens[3]!;
        const topicKey = tokens[4]!;
        const matchKey = `${topicName}:${topicKey}`;

        for (const session of this.sessions) {
            if (session.topics.has(matchKey)) {
                session.send({ type: 'topic', name: topicName, key: topicKey, payload: data });
            }
        }
    }

    private onGCMessage(data: Record<string, unknown>): void {
        for (const session of this.sessions) {
            session.send({ type: 'gc', payload: data });
        }
    }

    // ── Peer ack (GC) ────────────────────────────────────────────────────

    private reportPeerAck(): void {
        if (this.sessions.size === 0) return;

        let minSeq = Infinity;
        for (const session of this.sessions) {
            for (const [, seq] of session.channelSeqs) {
                if (seq < minSeq) minSeq = seq;
            }
        }
        if (!isFinite(minSeq)) return;

        const url = `${this.restateUrl}/workspace/${this.workspaceId}/reportPeerSeq`;
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientId: `gateway-${this.workspaceId}`,
                userId: '__gateway__',
                lastSeq: minSeq,
            }),
        }).catch(() => { /* best effort */ });
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/gateway/workspace-bridge.ts packages/server/package.json
git commit -m "feat(gateway): add WorkspaceBridge with NATS routing"
```

---

### Task 5: Gateway Server + Standalone Entry

**Files:**
- Create: `packages/server/src/gateway/server.ts`
- Create: `packages/server/src/gateway/standalone.ts`
- Create: `packages/server/src/gateway/index.ts`

- [ ] **Step 1: Create server.ts**

```typescript
// packages/server/src/gateway/server.ts
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { WorkspaceBridge, type BridgeConfig } from './workspace-bridge.js';
import { ClientSession } from './client-session.js';
import type { ClientMsg, InitMsg } from './protocol.js';

export interface GatewayConfig {
    natsUrl: string;
    restateUrl: string;
}

export class GatewayServer {
    private readonly config: GatewayConfig;
    private readonly bridges = new Map<string, WorkspaceBridge>();
    private readonly wss: WebSocketServer;

    constructor(config: GatewayConfig) {
        this.config = config;
        this.wss = new WebSocketServer({ noServer: true });
        this.wss.on('connection', (ws) => this.onConnection(ws));
    }

    /** Handle an HTTP upgrade request. Call from server.on('upgrade'). */
    handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss.emit('connection', ws, req);
        });
    }

    /** Create an HTTP server with /healthz and WS upgrade on /gateway. */
    listen(port: number): Server {
        const httpServer = createServer((req, res) => {
            if (req.url === '/healthz') {
                res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
                return;
            }
            res.writeHead(404).end('Not Found');
        });

        httpServer.on('upgrade', (req, socket, head) => {
            const pathname = (req.url ?? '').split('?')[0];
            if (pathname === '/gateway') {
                this.handleUpgrade(req, socket, head);
            } else {
                socket.destroy();
            }
        });

        httpServer.listen(port, () => {
            console.log(`[gateway] listening on :${port}`);
        });

        return httpServer;
    }

    async shutdown(): Promise<void> {
        for (const [, bridge] of this.bridges) {
            await bridge.stop();
        }
        this.bridges.clear();
        this.wss.close();
    }

    // ── Connection handling ───────────────────────────────────────────

    private onConnection(ws: WebSocket): void {
        let session: ClientSession | null = null;
        let bridge: WorkspaceBridge | null = null;
        let authToken: string | undefined;

        ws.on('message', async (data) => {
            let msg: ClientMsg;
            try {
                msg = JSON.parse(data.toString()) as ClientMsg;
            } catch {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
                return;
            }

            // Must init first
            if (msg.type === 'init') {
                const init = msg as InitMsg;
                session = new ClientSession(init.clientId, ws as any);
                authToken = init.authToken;
                bridge = await this.getOrCreateBridge(init.workspaceId);
                bridge.addSession(session);

                // Ensure entity-writes consumer + channel consumers
                await bridge.ensureEntityWritesConsumer();
                for (const ch of init.channels) {
                    await bridge.ensureChannelConsumer(ch);
                }

                ws.send(JSON.stringify({ type: 'ready' }));
                return;
            }

            if (!session || !bridge) {
                ws.send(JSON.stringify({ type: 'error', message: 'Must send init first', code: 'NO_INIT' }));
                return;
            }

            switch (msg.type) {
                case 'subscribe':
                    if (msg.kind === 'channel') {
                        session.subscribeChannel(msg.name);
                        await bridge.ensureChannelConsumer(msg.name);
                        if (msg.lastSeq != null && msg.lastSeq > 0) {
                            bridge.replayChannel(session, msg.name, msg.lastSeq);
                        } else {
                            session.send({ type: 'replay-end', channel: msg.name });
                        }
                    } else if (msg.kind === 'entity') {
                        session.subscribeEntity(msg.entity, msg.key);
                    } else if (msg.kind === 'topic') {
                        session.subscribeTopic(msg.name, msg.key);
                    }
                    break;

                case 'unsubscribe':
                    if (msg.kind === 'channel') session.unsubscribeChannel(msg.name);
                    else if (msg.kind === 'entity') session.unsubscribeEntity(msg.entity, msg.key);
                    else if (msg.kind === 'topic') session.unsubscribeTopic(msg.name, msg.key);
                    break;

                case 'publish':
                    if (msg.kind === 'delta') {
                        bridge.publishDelta(msg.subject, msg.payload);
                    } else if (msg.kind === 'topic') {
                        bridge.publishTopicLocal(
                            msg.subject.split('.')[3] ?? '',
                            msg.subject.split('.')[4] ?? '',
                            msg.payload,
                            session.clientId,
                        );
                    } else if (msg.kind === 'authority') {
                        void bridge.publishAuthority(msg.viewName, msg.deltas, authToken);
                    }
                    break;
            }
        });

        ws.on('close', () => {
            if (session && bridge) bridge.removeSession(session);
        });

        ws.on('error', () => {
            if (session && bridge) bridge.removeSession(session);
        });
    }

    private async getOrCreateBridge(workspaceId: string): Promise<WorkspaceBridge> {
        let bridge = this.bridges.get(workspaceId);
        if (bridge) return bridge;

        bridge = new WorkspaceBridge({
            natsUrl: this.config.natsUrl,
            restateUrl: this.config.restateUrl,
            workspaceId,
        });
        bridge.onEmpty = () => {
            void bridge!.stop();
            this.bridges.delete(workspaceId);
        };
        this.bridges.set(workspaceId, bridge);
        await bridge.start();
        return bridge;
    }
}
```

- [ ] **Step 2: Create standalone.ts**

```typescript
// packages/server/src/gateway/standalone.ts
import { GatewayServer } from './server.js';

const PORT = parseInt(process.env.PORT ?? '9333', 10);
const NATS_URL = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
const RESTATE_URL = process.env.SYNCENGINE_RESTATE_URL ?? 'http://localhost:8080';

const gateway = new GatewayServer({ natsUrl: NATS_URL, restateUrl: RESTATE_URL });
gateway.listen(PORT);

process.on('SIGTERM', async () => { await gateway.shutdown(); process.exit(0); });
process.on('SIGINT', async () => { await gateway.shutdown(); process.exit(0); });
```

- [ ] **Step 3: Create index.ts**

```typescript
// packages/server/src/gateway/index.ts
export { GatewayServer, type GatewayConfig } from './server.js';
export { WorkspaceBridge, type BridgeConfig } from './workspace-bridge.js';
export { ClientSession } from './client-session.js';
export { RingBuffer, type RingEntry } from './ring-buffer.js';
export type * from './protocol.js';
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/gateway/server.ts packages/server/src/gateway/standalone.ts packages/server/src/gateway/index.ts
git commit -m "feat(gateway): add GatewayServer and standalone entry point"
```

---

### Task 6: Runtime Config Plumbing (gatewayUrl end-to-end)

**Files:**
- Modify: `packages/core/src/http.ts`
- Modify: `packages/client/src/runtime-config.d.ts`
- Modify: `packages/vite-plugin/src/index.ts`
- Modify: `packages/vite-plugin/src/workspaces.ts`
- Modify: `packages/cli/src/state.ts`

This task threads `gatewayUrl` through every layer: meta tags -> virtual module -> runtime config -> worker init.

- [ ] **Step 1: Add gatewayUrl to injectMetaTags in http.ts**

In `packages/core/src/http.ts`, update the `injectMetaTags` function and its `values` parameter to include an optional `gatewayUrl`:

```typescript
// Change the values type to include gatewayUrl
export function injectMetaTags(
    html: string,
    values: { workspaceId: string; natsUrl: string; restateUrl: string; gatewayUrl?: string },
): string {
    if (html.includes(META_MARKER)) return html;

    const meta = [
        `<meta name="syncengine-workspace-id" content="${escapeAttr(values.workspaceId)}">`,
        `<meta name="syncengine-nats-url" content="${escapeAttr(values.natsUrl)}">`,
        `<meta name="syncengine-restate-url" content="${escapeAttr(values.restateUrl)}">`,
        ...(values.gatewayUrl ? [`<meta name="syncengine-gateway-url" content="${escapeAttr(values.gatewayUrl)}">`] : []),
    ].join('\n    ');

    if (html.includes('</head>')) {
        return html.replace('</head>', `    ${meta}\n  </head>`);
    }
    return html.replace('<head>', `<head>\n    ${meta}`);
}
```

- [ ] **Step 2: Add gatewayUrl to runtime-config.d.ts**

In `packages/client/src/runtime-config.d.ts`, add the new export:

```typescript
declare module 'virtual:syncengine/runtime-config' {
    export const workspaceId: string;
    export const natsUrl: string;
    export const gatewayUrl: string;
    export const restateUrl: string;
    export const authToken: string | null;
}
```

- [ ] **Step 3: Add gatewayUrl to virtual module renderer in vite-plugin/index.ts**

In `packages/vite-plugin/src/index.ts`, add to `RuntimeConfig` interface and `renderRuntimeConfigModule`:

Add `gatewayUrl?: string` to the `RuntimeConfig` interface (around line 50).

In `renderRuntimeConfigModule` (around line 262), add after the `natsUrl` line:

```typescript
const fallbackGatewayUrl = JSON.stringify(config.gatewayUrl ?? '');
```

And in the return array, add after the `natsUrl` line:

```typescript
`export const gatewayUrl = readMeta('gateway-url', ${fallbackGatewayUrl});`,
```

Also update `loadRuntimeConfig` to read `gatewayUrl` from runtime.json.

- [ ] **Step 4: Thread gatewayUrl through workspaces.ts meta tag injection**

In `packages/vite-plugin/src/workspaces.ts`, find the `injectMetaTags` call (~line 469) and add `gatewayUrl` to the values object. Read it from the resolved workspace context.

- [ ] **Step 5: Add gateway port to state.ts**

In `packages/cli/src/state.ts`, add to the `Ports` interface and `DEFAULT_PORTS`:

```typescript
export interface Ports {
    natsClient: number;
    natsWs: number;
    natsMonitor: number;
    restateIngress: number;
    restateAdmin: number;
    restateNode: number;
    workspace: number;
    gateway: number;   // <- new
    vite: number;
}

export const DEFAULT_PORTS: Ports = {
    natsClient: 4222,
    natsWs: 9222,
    natsMonitor: 8222,
    restateIngress: 8080,
    restateAdmin: 9070,
    restateNode: 5122,
    workspace: 9080,
    gateway: 9333,     // <- new
    vite: 5173,
};
```

Also add `gatewayUrl?: string` to the `RuntimeConfig` interface in the same file.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/http.ts packages/client/src/runtime-config.d.ts packages/vite-plugin/src/index.ts packages/vite-plugin/src/workspaces.ts packages/cli/src/state.ts
git commit -m "feat(gateway): thread gatewayUrl through runtime config pipeline"
```

---

### Task 7: Dev Orchestration (cli/dev.ts)

**Files:**
- Modify: `packages/cli/src/dev.ts`

- [ ] **Step 1: Add --raw-nats flag parsing and gateway boot step**

In `packages/cli/src/dev.ts`:

1. In `devCommand`, parse `--raw-nats`:
```typescript
const rawNats = args.includes('--raw-nats');
```

2. Add gateway port to `requirePortsFree` (unless `--raw-nats`):
```typescript
if (!rawNats) {
    portsToCheck.push({ port: ports.gateway, label: 'gateway' });
}
```

3. In the `boot` function, after workspace service registration (step 4) and before writing runtime.json (step 5), add:

```typescript
// 3.5 Gateway (unless --raw-nats)
if (!rawNats) {
    banner('starting gateway');
    const gatewayEntry = join(serverDir, 'src', 'gateway', 'standalone.ts');
    const gw = spawnManaged(tsxBin, ['src/gateway/standalone.ts'], {
        name: 'gateway',
        cwd: serverDir,
        env: {
            ...process.env,
            PORT: String(ports.gateway),
            NATS_URL: `nats://127.0.0.1:${ports.natsClient}`,
            SYNCENGINE_RESTATE_URL: `http://127.0.0.1:${ports.restateIngress}`,
        },
    });
    processes.push(gw);
    await waitForHttp(`http://127.0.0.1:${ports.gateway}/healthz`, {
        label: 'gateway',
        timeoutMs: 15_000,
    });
    note(`gateway :${ports.gateway}`);
}
```

4. Update `writeRuntimeConfig` call to include `gatewayUrl`:
```typescript
writeRuntimeConfig(stateDir, {
    natsUrl: `ws://localhost:${ports.natsWs}`,
    gatewayUrl: rawNats ? undefined : `ws://localhost:${ports.gateway}/gateway`,
    restateUrl: `http://localhost:${ports.restateIngress}`,
    authToken: null,
});
```

5. Add gateway to `printReadyBanner`:
```typescript
if (!rawNats) {
    // Add line: `  Gateway        → ws://localhost:${ports.gateway}/gateway`
}
```

6. Add `'gateway'` to the `Pids.children` type and `buildPidsSnapshot`.

- [ ] **Step 2: Commit**

```bash
git add packages/cli/src/dev.ts
git commit -m "feat(gateway): add gateway to dev orchestrator with --raw-nats escape hatch"
```

---

### Task 8: Client Transport — data-worker.js

**Files:**
- Modify: `packages/client/src/workers/data-worker.js`
- Modify: `packages/client/src/store.ts`

This is the largest client-side change. Add `connectGateway()` alongside the existing `connectNats()`.

- [ ] **Step 1: Pass gatewayUrl from store.ts to worker**

In `packages/client/src/store.ts`, add `gatewayUrl` to the SyncConfig construction (~line 356):

```typescript
const syncConfig: SyncConfig = {
    workspaceId: runtimeWorkspaceId,
    natsUrl: runtimeNatsUrl,
    gatewayUrl: runtimeGatewayUrl,  // new import from virtual module
    restateUrl: runtimeRestateUrl,
    ...(runtimeAuthToken ? { authToken: runtimeAuthToken } : {}),
    channels: allChannels,
};
```

Add the import of `gatewayUrl` from the virtual module at the top (~line 53).

- [ ] **Step 2: Add connectGateway() in data-worker.js**

In `packages/client/src/workers/data-worker.js`, add a new function after `connectNats()` (~after line 599):

```javascript
// ── Gateway transport ─────────────────────────────────────────────────────

async function connectGateway() {
    if (!nats.config) return;
    if (!nats.routing) {
        console.warn('[gateway] cannot connect: channel routing not initialized');
        return;
    }

    const gatewayUrl = nats.config.gatewayUrl;
    const channelSubjects = nats.routing.subjects;
    const channelNames = nats.routing.channelNames; // see step 3

    setConnectionStatus('connecting');

    try {
        const ws = new WebSocket(gatewayUrl);
        nats.gwWs = ws;

        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });

        console.log(`[gateway] connected to ${gatewayUrl}`);

        // Init handshake
        ws.send(JSON.stringify({
            type: 'init',
            workspaceId: nats.config.workspaceId,
            channels: channelNames,
            clientId: CLIENT_ID,
            authToken: nats.config.authToken || undefined,
        }));

        // Wait for ready
        await new Promise((resolve, reject) => {
            const handler = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'ready') {
                    ws.removeEventListener('message', handler);
                    resolve();
                } else if (msg.type === 'error') {
                    ws.removeEventListener('message', handler);
                    reject(new Error(msg.message));
                }
            };
            ws.addEventListener('message', handler);
        });

        // Initialize replay coordination
        sync.isReplaying = true;
        resetReplayCoord(channelNames.length);
        authority.backoff = 0;
        authority.backoffUntil = 0;

        // Subscribe to channels with lastSeq for replay
        for (const chName of channelNames) {
            const subject = nats.routing.channelNameToSubject[chName];
            const lastSeq = sync.lastProcessedSeqs[subject] || 0;
            ws.send(JSON.stringify({
                type: 'subscribe',
                kind: 'channel',
                name: chName,
                lastSeq,
            }));
        }

        // Resubscribe topics
        for (const [subKey] of topicState.desired) {
            const [name, key] = subKey.split('/');
            ws.send(JSON.stringify({ type: 'subscribe', kind: 'topic', name, key }));
        }

        // Main message handler
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            handleGatewayMessage(msg);
        };

        ws.onclose = () => {
            console.log('[gateway] connection closed');
            setConnectionStatus('disconnected');
            nats.gwWs = null;
            topicState.subs.clear();
            setTimeout(() => connectGateway(), NATS_RECONNECT_DELAY_MS);
        };

        ws.onerror = () => {
            // onclose will fire after onerror
        };

        setConnectionStatus('connected');

    } catch (e) {
        console.warn('[gateway] connection failed:', e.message || String(e));
        setConnectionStatus('disconnected');
        nats.gwWs = null;
        setTimeout(() => connectGateway(), NATS_RECONNECT_RETRY_MS);
    }
}

function handleGatewayMessage(msg) {
    switch (msg.type) {
        case 'delta': {
            // Process channel delta — same pipeline as processConsumer
            const subject = nats.routing?.channelNameToSubject[msg.channel];
            if (!subject) break;
            const payload = msg.payload;

            // Dedup
            if (payload._nonce && !dedup(payload._nonce)) break;

            // Apply to DBSP
            processIncomingDelta(subject, payload, msg.seq);
            break;
        }

        case 'entity-write': {
            const payload = msg.payload;
            if (payload._nonce && !dedup(payload._nonce)) break;
            const subject = `ws.${nats.config.workspaceId}.entity-writes`;
            processIncomingDelta(subject, payload, msg.seq);
            break;
        }

        case 'replay-end': {
            // Signal that this channel's replay is done
            markConsumerCaughtUp(msg.channel);
            break;
        }

        case 'authority': {
            const { viewName, payload } = msg;
            if (payload.type !== 'AUTHORITY_UPDATE') break;
            const { seq, deltas } = payload;
            const lastSeq = authority.seqs[viewName] || 0;
            if (seq <= lastSeq) break;
            authority.seqs[viewName] = seq;
            self.postMessage({
                type: 'VIEW_UPDATE',
                viewName,
                deltas: deltas.map(d => ({ record: d.record, weight: d.weight })),
            });
            break;
        }

        case 'gc': {
            const payload = msg.payload;
            if (payload.type === 'GC_COMPLETE' && payload.gcWatermark && nats.routing) {
                for (const s of nats.routing.subjects) {
                    if ((sync.lastProcessedSeqs[s] || 0) < payload.gcWatermark) {
                        sync.lastProcessedSeqs[s] = payload.gcWatermark;
                    }
                }
            }
            break;
        }

        case 'topic': {
            const { name, key, payload } = msg;
            self.postMessage({
                type: 'TOPIC_UPDATE',
                name,
                key,
                peerId: payload._clientId,
                data: payload,
                ts: payload.ts,
                leave: !!payload.$leave,
            });
            break;
        }

        case 'entity-state': {
            // entity-client handles this via its own gateway connection
            break;
        }
    }
}
```

- [ ] **Step 3: Add channelNames to routing and gateway publish helpers**

In the `buildChannelRouting` initialization area of data-worker.js, extend the routing object with `channelNames` (array of channel name strings) and `channelNameToSubject` (map of channel name to subject string).

Update the publish functions (`publishDelta`, `publishTopic`, `sendToAuthority`) to route through the gateway WebSocket when `nats.gwWs` is set:

```javascript
// In the existing publish path:
function gwPublishDelta(subject, payload) {
    if (nats.gwWs && nats.gwWs.readyState === WebSocket.OPEN) {
        nats.gwWs.send(JSON.stringify({ type: 'publish', kind: 'delta', subject, payload }));
        return true;
    }
    return false;
}

function gwPublishTopic(subject, payload) {
    if (nats.gwWs && nats.gwWs.readyState === WebSocket.OPEN) {
        nats.gwWs.send(JSON.stringify({ type: 'publish', kind: 'topic', subject, payload }));
        return true;
    }
    return false;
}

function gwSendAuthority(viewName, deltas) {
    if (nats.gwWs && nats.gwWs.readyState === WebSocket.OPEN) {
        nats.gwWs.send(JSON.stringify({ type: 'publish', kind: 'authority', viewName, deltas }));
        return true;
    }
    return false;
}
```

- [ ] **Step 4: Add transport selection at connect time**

In the INIT message handler (where `connectNats()` is currently called), add transport selection:

```javascript
// In the INIT handler, replace the connectNats() call:
if (nats.config.gatewayUrl) {
    connectGateway();
} else {
    connectNats();
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/workers/data-worker.js packages/client/src/store.ts
git commit -m "feat(gateway): add gateway transport to data-worker"
```

---

### Task 9: Client Transport — entity-client.ts

**Files:**
- Modify: `packages/client/src/entity-client.ts`

- [ ] **Step 1: Add gateway connection path**

Add a `gatewayUrl` import from the virtual module alongside `natsUrl`:

```typescript
import {
    workspaceId as runtimeWorkspaceId,
    natsUrl as runtimeNatsUrl,
    gatewayUrl as runtimeGatewayUrl,
    authToken as runtimeAuthToken,
} from 'virtual:syncengine/runtime-config';
```

Add a parallel `getGateway()` function that opens a shared gateway WebSocket:

```typescript
let gwPromise: Promise<WebSocket> | null = null;
const gwEntityHandlers = new Map<string, (data: Record<string, unknown>) => void>();

function getGateway(): Promise<WebSocket> {
    if (!gwPromise) {
        gwPromise = new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(runtimeGatewayUrl);
            ws.onopen = () => {
                ws.send(JSON.stringify({
                    type: 'init',
                    workspaceId: runtimeWorkspaceId,
                    channels: [],
                    clientId: `entity-${crypto.randomUUID().slice(0, 8)}`,
                    authToken: runtimeAuthToken || undefined,
                }));
            };
            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data as string);
                if (msg.type === 'ready') {
                    resolve(ws);
                } else if (msg.type === 'entity-state') {
                    const key = `${msg.entity}:${msg.key}`;
                    gwEntityHandlers.get(key)?.(msg.payload);
                }
            };
            ws.onerror = () => { gwPromise = null; reject(new Error('Gateway connection failed')); };
            ws.onclose = () => { gwPromise = null; };
        });
    }
    return gwPromise;
}
```

- [ ] **Step 2: Use gateway in getOrCreateSubscription when gatewayUrl is set**

In `getOrCreateSubscription` (~line 213 where the NATS subscription is created), add a branch:

```typescript
if (runtimeGatewayUrl) {
    // Gateway path
    (async () => {
        try {
            const gw = await getGateway();
            const matchKey = `${entity.$name}:${key}`;
            gwEntityHandlers.set(matchKey, (payload) => {
                const decoded = payload as { type?: string; state?: Record<string, unknown> };
                if (decoded.type === 'ENTITY_STATE' && decoded.state) {
                    const wasReady = sub.ready;
                    sub.ready = true;
                    sub.error = null;
                    setConfirmed(sub, decoded.state);
                    if (!wasReady) notify(sub);
                }
            });
            gw.send(JSON.stringify({
                type: 'subscribe',
                kind: 'entity',
                entity: entity.$name,
                key,
            }));
        } catch (err) {
            console.warn('[entity-client] gateway subscribe failed:', err);
        }
    })();
} else {
    // Existing NATS path (unchanged)
    // ...
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/entity-client.ts
git commit -m "feat(gateway): add gateway transport to entity-client"
```

---

### Task 10: Production Integration (serve.ts)

**Files:**
- Modify: `packages/server/src/serve.ts`

- [ ] **Step 1: Embed GatewayServer in production HTTP server**

In `packages/server/src/serve.ts`, import and instantiate the gateway:

```typescript
import { GatewayServer } from './gateway/server.js';
```

In `startHttpServer`, after the `createServer` call, add:

```typescript
const gateway = new GatewayServer({
    natsUrl: (config.natsUrl ?? 'ws://localhost:9222').replace(/^ws/, 'nats').replace(/:9222/, ':4222'),
    restateUrl: config.restateUrl,
});

server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname === '/gateway') {
        gateway.handleUpgrade(req, socket, head);
    } else {
        socket.destroy();
    }
});
```

Update the `injectMetaTags` call in `serveHtml` to include `gatewayUrl`:

```typescript
const gatewayUrl = `ws://${req.headers.host}/gateway`;
const html = injectMetaTags(opts.indexHtml, {
    workspaceId: wsKey,
    natsUrl: opts.natsUrl,
    restateUrl: opts.restateUrl,
    gatewayUrl,
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/serve.ts
git commit -m "feat(gateway): embed gateway in production HTTP server"
```

---

### Task 11: Smoke Test

**Files:**
- No new files — manual verification

- [ ] **Step 1: Start the dev stack with gateway**

Run: `cd apps/test && pnpm syncengine dev`

Expected:
- Gateway starts on :9333
- Ready banner shows Gateway line
- Browser loads at http://localhost:5173

- [ ] **Step 2: Verify two-tab sync still works**

1. Open http://localhost:5173?user=alice
2. Open http://localhost:5173?user=bob
3. In Alice's tab: click "Restock +5" on headphones
4. In Bob's tab: verify stock updates live
5. Move cursors: verify collaborative cursors appear
6. Place an order via Checkout tab: verify it appears in Orders tab

Expected: All live sync behavior works identically to direct NATS.

- [ ] **Step 3: Verify --raw-nats escape hatch**

Run: `cd apps/test && pnpm syncengine dev --raw-nats`

Expected:
- No gateway process spawned
- Browser connects directly to NATS on :9222
- Same sync behavior works

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(gateway): smoke test fixes"
```

---

## Summary

| Task | Component | New/Modify | Estimated Steps |
|------|-----------|------------|-----------------|
| 1 | Protocol types | New | 2 |
| 2 | Ring buffer + tests | New | 5 |
| 3 | Client session + tests | New | 5 |
| 4 | Workspace bridge | New | 3 |
| 5 | Gateway server + standalone | New | 4 |
| 6 | Runtime config plumbing | Modify 5 files | 6 |
| 7 | Dev orchestration | Modify 1 file | 2 |
| 8 | Data-worker transport | Modify 2 files | 5 |
| 9 | Entity-client transport | Modify 1 file | 3 |
| 10 | Production serve.ts | Modify 1 file | 2 |
| 11 | Smoke test | Manual | 4 |

**Total: 11 tasks, ~41 steps**

Tasks 1-5 are independent server-side work (can be parallelized in pairs). Task 6 must complete before tasks 7-9. Task 10 is independent of tasks 7-9. Task 11 requires all others.
