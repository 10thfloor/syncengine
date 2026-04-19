// Node `ws`-backed adapter over @syncengine/gateway-core. Purely glue:
// every WebSocket that lands here becomes a GatewayCore session and
// every protocol concern lives in gateway-core.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
    GatewayCore,
    type GatewayClientWs,
    type GatewayConfig,
    type GatewaySessionHandle,
} from '@syncengine/gateway-core';

// Re-export the config shape so existing imports keep working.
export type { GatewayConfig };

export class GatewayServer {
    private readonly core: GatewayCore;
    private readonly wss: WebSocketServer;

    constructor(config: GatewayConfig) {
        this.core = new GatewayCore(config);
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
        await this.core.shutdown();
        this.wss.close();
    }

    private onConnection(ws: WebSocket): void {
        const session: GatewaySessionHandle = this.core.attach(wrapWs(ws));

        ws.on('message', (data) => {
            // ws emits Buffer for binary frames, string for text. The
            // protocol is JSON so `toString()` is always safe.
            void session.handleMessage(data.toString());
        });
        ws.on('close', () => session.handleClose());
        ws.on('error', () => session.handleClose());
    }
}

/** Wrap a Node ws WebSocket in the GatewayClientWs contract. */
function wrapWs(ws: WebSocket): GatewayClientWs {
    return {
        send(data: string): void { ws.send(data); },
        close(code?: number, reason?: string): void { ws.close(code, reason); },
        get isOpen(): boolean { return ws.readyState === ws.OPEN; },
    };
}
