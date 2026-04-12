import type { ServerMsg } from './protocol.js';

export class ClientSession {
    readonly clientId: string;
    readonly channels = new Set<string>();
    readonly entities = new Set<string>();
    readonly topics = new Set<string>();
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
