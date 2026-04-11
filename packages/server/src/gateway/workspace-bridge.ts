// packages/server/src/gateway/workspace-bridge.ts
import { connect, type NatsConnection, type Subscription } from '@nats-io/transport-node';
import { jetstream, DeliverPolicy, type JetStreamClient } from '@nats-io/jetstream';
import { RingBuffer } from './ring-buffer.js';
import { ClientSession } from './client-session.js';
import { streamName } from '../workspace/workspace.js';
import { provisionWorkspace } from '@syncengine/core/http';

const PEER_ACK_INTERVAL_MS = 5 * 60_000;
const TEARDOWN_GRACE_MS = 30_000;
const ENTITY_WRITES_CONSUMER_KEY = '__entity-writes__';

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
        // Provision the workspace — creates the NATS JetStream stream if
        // it doesn't exist. Required for client-initiated workspace switches
        // where the new workspace hasn't been seen by this dev session.
        await provisionWorkspace(this.restateUrl, this.workspaceId);

        this.nc = await connect({ servers: this.natsUrl });
        this.js = jetstream(this.nc);
        const wsId = this.workspaceId;

        this.subscribeCoreSubject(`ws.${wsId}.entity.>`, this.onEntityMessage.bind(this));
        this.subscribeCoreSubject(`ws.${wsId}.authority.>`, this.onAuthorityMessage.bind(this));
        this.subscribeCoreSubject(`ws.${wsId}.topic.>`, this.onTopicMessage.bind(this));
        this.subscribeCoreSubject(`ws.${wsId}.gc`, this.onGCMessage.bind(this));

        this.peerAckTimer = setInterval(() => this.reportPeerAck(), PEER_ACK_INTERVAL_MS);
    }

    async stop(): Promise<void> {
        if (this.closed) return;
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
        const subject = `ws.${this.workspaceId}.ch.${channelName}.deltas`;
        await this.startConsumer(channelName, subject, (session, seq, payload, msgClientId) => {
            if (!session.channels.has(channelName)) return;
            if (session.replayingChannels.has(channelName)) return;
            if (msgClientId === session.clientId) return;
            session.send({ type: 'delta', channel: channelName, seq, payload });
            session.channelSeqs.set(channelName, seq);
        });
    }

    async ensureEntityWritesConsumer(): Promise<void> {
        const subject = `ws.${this.workspaceId}.entity-writes`;
        await this.startConsumer(ENTITY_WRITES_CONSUMER_KEY, subject, (session, seq, payload, msgClientId) => {
            if (msgClientId === session.clientId) return;
            session.send({ type: 'entity-write', seq, payload });
        });
    }

    private async startConsumer(
        key: string,
        subject: string,
        dispatch: (session: ClientSession, seq: number, payload: Record<string, unknown>, msgClientId: string) => void,
    ): Promise<void> {
        if (this.channelConsumers.has(key)) return;
        if (!this.js || !this.nc || this.closed) return;

        const stream = streamName(this.workspaceId);
        const ring = new RingBuffer();
        this.channelRings.set(key, ring);

        try {
            const consumer = await this.js.consumers.get(stream, {
                filter_subjects: [subject],
                deliver_policy: DeliverPolicy.New,
            });
            const messages = await consumer.consume();
            const tracker = { stopped: false, stop() { this.stopped = true; messages.stop(); } };
            this.channelConsumers.set(key, tracker);

            (async () => {
                for await (const raw of messages) {
                    if (tracker.stopped) break;
                    try {
                        const payload = raw.json<Record<string, unknown>>();
                        const seq = raw.seq;
                        const msgClientId = (payload._clientId as string) ?? '';
                        ring.push(seq, payload, msgClientId);
                        for (const session of this.sessions) {
                            dispatch(session, seq, payload, msgClientId);
                        }
                    } catch { /* decode error */ }
                    raw.ack();
                }
            })().catch((err) => {
                if (!tracker.stopped) console.error(`[gateway] consumer ${key}:`, err);
            });
        } catch (err) {
            console.warn(`[gateway] failed to create consumer for ${key}:`, err);
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
        this.nc.publish(subject, JSON.stringify(payload));
    }

    publishTopicLocal(name: string, key: string, payload: Record<string, unknown>, _senderClientId: string): void {
        // Local echo: route to interested sessions immediately (low latency
        // for cursors/presence) without waiting for the NATS round-trip.
        const matchKey = `${name}:${key}`;
        for (const session of this.sessions) {
            if (session.topics.has(matchKey)) {
                session.send({ type: 'topic', name, key, payload });
            }
        }

        // Also publish to NATS so other gateway instances (future) and
        // non-gateway subscribers receive the message.
        const subject = `ws.${this.workspaceId}.topic.${name}.${key}`;
        if (this.nc && !this.nc.isClosed()) {
            this.nc.publish(subject, JSON.stringify(payload));
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
                    const data = msg.json<Record<string, unknown>>();
                    handler(data, msg.subject.split('.'));
                } catch { /* decode error */ }
            }
        })().catch(() => { /* sub closed */ });
    }

    private onEntityMessage(data: Record<string, unknown>, tokens: string[]): void {
        // Subject: ws.{wsId}.entity.{entityName}.{entityKey...}.state
        // Entity keys may contain dots, so join everything between index 4 and the terminal 'state'.
        if (tokens.length < 6) return;
        const entityName = tokens[3]!;
        const entityKey = tokens.slice(4, -1).join('.');
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
        // Subject: ws.{wsId}.topic.{topicName}.{topicKey...}
        // Topic keys may contain dots — join everything from index 4 onward.
        if (tokens.length < 5) return;
        const topicName = tokens[3]!;
        const topicKey = tokens.slice(4).join('.');
        const matchKey = `${topicName}:${topicKey}`;

        // Skip messages from local sessions — they were already delivered
        // via publishTopicLocal's local echo path.
        const msgClientId = (data._clientId as string) ?? '';
        let isLocal = false;
        for (const s of this.sessions) {
            if (s.clientId === msgClientId) { isLocal = true; break; }
        }
        if (isLocal) return;

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
