// packages/server/src/gateway/server.ts
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { WorkspaceBridge } from './workspace-bridge.js';
import { ClientSession } from './client-session.js';
import type { ClientMsg, ClientInitMessage } from './protocol.js';

export interface GatewayConfig {
    natsUrl: string;
    restateUrl: string;
}

export class GatewayServer {
    private readonly config: GatewayConfig;
    private readonly bridges = new Map<string, WorkspaceBridge>();
    private readonly bridgeCreating = new Map<string, Promise<WorkspaceBridge>>();
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

            if (msg.type === 'init') {
                const init = msg as ClientInitMessage;
                session = new ClientSession(init.clientId, ws as any);
                authToken = init.authToken;
                bridge = await this.getOrCreateBridge(init.workspaceId);
                bridge.addSession(session);

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
                        // Mark replaying BEFORE subscribing interest so the
                        // live consumer loop skips this session for this channel
                        // until replay-end is sent.
                        if (msg.lastSeq != null && msg.lastSeq > 0) {
                            session.replayingChannels.add(msg.name);
                        }
                        session.subscribeChannel(msg.name);
                        await bridge.ensureChannelConsumer(msg.name);
                        if (msg.lastSeq != null && msg.lastSeq > 0) {
                            bridge.replayChannel(session, msg.name, msg.lastSeq);
                            session.replayingChannels.delete(msg.name);
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
                        // Parse topic name/key from subject: ws.{wsId}.topic.{name}.{key}
                        const parts = msg.subject.split('.');
                        bridge.publishTopicLocal(parts[3] ?? '', parts[4] ?? '', msg.payload, session.clientId);
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

    private getOrCreateBridge(workspaceId: string): Promise<WorkspaceBridge> {
        const existing = this.bridges.get(workspaceId);
        if (existing) return Promise.resolve(existing);

        let inflight = this.bridgeCreating.get(workspaceId);
        if (!inflight) {
            inflight = this.createBridge(workspaceId).finally(() => {
                this.bridgeCreating.delete(workspaceId);
            });
            this.bridgeCreating.set(workspaceId, inflight);
        }
        return inflight;
    }

    private async createBridge(workspaceId: string): Promise<WorkspaceBridge> {
        const bridge = new WorkspaceBridge({
            natsUrl: this.config.natsUrl,
            restateUrl: this.config.restateUrl,
            workspaceId,
        });
        bridge.onEmpty = () => {
            // Guard: stop() is idempotent (checks this.closed internally)
            void bridge.stop();
            this.bridges.delete(workspaceId);
        };
        this.bridges.set(workspaceId, bridge);
        await bridge.start();
        return bridge;
    }
}
