/**
 * `/gateway` WebSocket reverse proxy for the Bun edge.
 *
 * The client uses a same-origin WebSocket (`ws(s)://<edge-host>/gateway`)
 * to reach the syncengine GatewayServer, which runs inside the Node
 * bundle (handlers container). This module bridges that connection in
 * the scale-out topology: the edge upgrades the inbound WS, opens a
 * parallel WS to the upstream gateway, and pipes frames in both
 * directions. Close/error on either side tears the other down.
 *
 * Bun's `server.upgrade()` + `websocket` handlers carry per-connection
 * state via `data`; we stash the upstream client there so the message
 * callback can look it up in O(1).
 */

import type { ServerWebSocket } from 'bun';
import type { Logger } from './logger.ts';

// `Bun.serve` returns a generic `Server<WebSocketData>`; we pass ours
// through as `unknown` at the call site and narrow the upgrade() call
// here rather than propagating the generic through every caller.
type BunServer = {
    upgrade: <T>(req: Request, opts: { data: T }) => boolean;
};

export interface GatewayProxyOptions {
    /** Upstream gateway URL, e.g. `ws://handlers:3000/gateway`.
     *  Edge reaches handlers over the compose network. */
    readonly upstreamUrl: string;
    readonly logger: Logger;
}

type ClientData = {
    readonly upstream: WebSocket;
    /** Frames that arrived before the upstream finished opening. */
    readonly pending: Array<string | ArrayBufferLike>;
    upstreamOpen: boolean;
};

/**
 * Attempt to upgrade a `/gateway` request. Returns true if handled
 * (either upgrade succeeded or was rejected), false if the caller
 * should try the normal fetch handler.
 *
 * Note: Bun's WebSocket constructor doesn't support custom headers,
 * so we can't forward Cookie / Authorization over the proxy hop. The
 * gateway's auth model relies on the init message payload instead
 * (workspaceId + token), which carries over untouched.
 */
export function tryUpgradeGateway(
    req: Request,
    server: BunServer,
    opts: GatewayProxyOptions,
): boolean {
    const url = new URL(req.url);
    if (url.pathname !== '/gateway') return false;

    const upstream = new WebSocket(opts.upstreamUrl);

    const data: ClientData = { upstream, pending: [], upstreamOpen: false };

    // `server.upgrade` returns true when the response becomes 101. From
    // this point on, only the ws handlers (open/message/close) fire on
    // the client side.
    const upgraded = server.upgrade(req, { data });
    if (!upgraded) {
        upstream.close();
        return false;
    }

    // Wire upstream lifecycle. The ws client reference for the downstream
    // browser is published to us in `open()`; until then, queue frames.
    const queue: Array<string | ArrayBufferLike> = [];
    let clientWs: ServerWebSocket<ClientData> | null = null;

    upstream.addEventListener('open', () => {
        data.upstreamOpen = true;
        for (const frame of data.pending) {
            upstream.send(frame);
        }
        data.pending.length = 0;
        for (const frame of queue) {
            clientWs?.send(frame);
        }
        queue.length = 0;
    });

    upstream.addEventListener('message', (ev) => {
        const payload = ev.data as string | ArrayBuffer | Blob;
        if (clientWs && clientWs.readyState === 1) {
            clientWs.send(payload as string | ArrayBufferLike);
        } else {
            queue.push(payload as string | ArrayBufferLike);
        }
    });

    upstream.addEventListener('close', (ev) => {
        try { clientWs?.close(ev.code, ev.reason); } catch { /* best effort */ }
    });

    upstream.addEventListener('error', () => {
        opts.logger.warn({ event: 'gateway.upstream.error' });
        try { clientWs?.close(1011, 'upstream error'); } catch { /* best effort */ }
    });

    // Give the open handler a way to set clientWs via global state on
    // the server. We publish clientWs through `data` — ws handlers
    // receive `(ws: ServerWebSocket<ClientData>)` and can reach back
    // through `ws.data` if needed, but the other direction (ws from
    // data) needs the assignment below via the open callback.
    (data as ClientData & { _setClient?: (ws: ServerWebSocket<ClientData>) => void })._setClient = (ws) => {
        clientWs = ws;
    };

    return true;
}

/**
 * Bun websocket handler tuple for the proxy. Plug this into
 * `Bun.serve({ websocket: createGatewayWebsocketHandler(opts) })` so
 * the runtime dispatches open/message/close to the right callbacks.
 */
export function createGatewayWebsocketHandler(_opts: GatewayProxyOptions) {
    return {
        open(ws: ServerWebSocket<ClientData>) {
            const setter = (ws.data as ClientData & { _setClient?: (ws: ServerWebSocket<ClientData>) => void })
                ._setClient;
            setter?.(ws);
            // If upstream was opened synchronously (unlikely but
            // possible), drain queued frames now.
            // (handled in upstream.open listener via clientWs check)
        },
        message(ws: ServerWebSocket<ClientData>, message: string | Buffer) {
            const { upstream, upstreamOpen, pending } = ws.data;
            const frame =
                typeof message === 'string'
                    ? message
                    : (message.buffer.slice(
                          message.byteOffset,
                          message.byteOffset + message.byteLength,
                      ) as ArrayBufferLike);
            if (upstreamOpen) {
                upstream.send(frame as string | ArrayBufferLike);
            } else {
                pending.push(frame);
            }
        },
        close(ws: ServerWebSocket<ClientData>, code: number, reason: string) {
            try { ws.data.upstream.close(code, reason); } catch { /* best effort */ }
        },
    };
}
