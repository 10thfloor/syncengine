import type { ServerMsg } from './protocol';

/**
 * Minimal WebSocket-like interface the gateway needs from its client
 * transport. Node's `ws` and Bun's `ServerWebSocket` both satisfy this
 * via thin adapters, so the same gateway core works in either runtime.
 * `send` on a closed socket is a no-op — the adapter is expected to
 * keep `isOpen` honest.
 */
export interface GatewayClientWs {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    readonly isOpen: boolean;
}

export class ClientSession {
    readonly clientId: string;
    readonly channels = new Set<string>();
    readonly entities = new Set<string>();
    readonly topics = new Set<string>();
    readonly channelSeqs = new Map<string, number>();
    /** Channels currently being replayed — live messages are buffered until replay-end. */
    readonly replayingChannels = new Set<string>();

    private readonly ws: GatewayClientWs;

    constructor(clientId: string, ws: GatewayClientWs) {
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
        if (!this.ws.isOpen) return;
        this.ws.send(JSON.stringify(msg));
    }
}
