// packages/server/src/gateway/workspace-bridge.ts
import {
    connect,
    JSONCodec,
    type NatsConnection,
    type JetStreamClient,
    type Subscription,
    DeliverPolicy,
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

    onEmpty: (() => void) | null = null;

    constructor(config: BridgeConfig) {
        this.workspaceId = config.workspaceId;
        this.natsUrl = config.natsUrl;
        this.restateUrl = config.restateUrl;
    }

    async start(): Promise<void> {
        this.nc = await connect({ servers: this.natsUrl });
        this.js = this.nc.jetstream();
        const wsId = this.workspaceId;

        this.subscribeCoreSubject(`ws.${wsId}.entity.>`, this.onEntityMessage.bind(this));
        this.subscribeCoreSubject(`ws.${wsId}.authority.>`, this.onAuthorityMessage.bind(this));
        this.subscribeCoreSubject(`ws.${wsId}.topic.>`, this.onTopicMessage.bind(this));
        this.subscribeCoreSubject(`ws.${wsId}.gc`, this.onGCMessage.bind(this));

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
                deliver_policy: DeliverPolicy.New,
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
                    } catch { /* decode error */ }
                    raw.ack();
                }
            })().catch((err) => {
                if (!tracker.stopped) console.error(`[gateway] channel consumer ${channelName}:`, err);
            });
        } catch (err) {
            console.warn(`[gateway] failed to create consumer for channel ${channelName}:`, err);
        }
    }

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
                deliver_policy: DeliverPolicy.New,
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

    publishDelta(subject: string, payload: Record<string, unknown>): void {
        if (!this.nc || this.nc.isClosed()) return;
        this.nc.publish(subject, this.codec.encode(payload));
    }

    publishTopicLocal(name: string, key: string, payload: Record<string, unknown>, _senderClientId: string): void {
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
            await fetch(url, { method: 'POST', headers, body: JSON.stringify({ viewName, deltas }) });
        } catch (err) {
            console.warn(`[gateway] authority POST failed:`, err);
        }
    }

    private subscribeCoreSubject(subject: string, handler: (data: Record<string, unknown>, tokens: string[]) => void): void {
        if (!this.nc) return;
        const sub = this.nc.subscribe(subject);
        this.coreSubs.push(sub);
        (async () => {
            for await (const msg of sub) {
                try {
                    const data = this.codec.decode(msg.data) as Record<string, unknown>;
                    handler(data, msg.subject.split('.'));
                } catch { /* decode error */ }
            }
        })().catch(() => { /* sub closed */ });
    }

    private onEntityMessage(data: Record<string, unknown>, tokens: string[]): void {
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
        if (tokens.length < 4) return;
        const viewName = tokens[3]!;
        for (const session of this.sessions) {
            if (session.channels.size > 0) {
                session.send({ type: 'authority', viewName, payload: data });
            }
        }
    }

    private onTopicMessage(data: Record<string, unknown>, tokens: string[]): void {
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
