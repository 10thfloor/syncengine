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
 * All lifecycle state lives on the per-connection `ClientData` that
 * Bun carries via `server.upgrade(req, { data })` — the upstream
 * listeners and the server-side WebSocket callbacks share it so
 * frames arriving before either side's `open` event get queued
 * and drained once both sides are ready.
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
    /** Frames from the browser that arrived before upstream opened. */
    readonly pendingToUpstream: Array<string | ArrayBufferLike>;
    /** Frames from upstream that arrived before the browser ws opened. */
    readonly pendingToClient: Array<string | ArrayBufferLike>;
    upstreamOpen: boolean;
    clientWs: ServerWebSocket<ClientData> | null;
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

    const data: ClientData = {
        upstream,
        pendingToUpstream: [],
        pendingToClient: [],
        upstreamOpen: false,
        clientWs: null,
    };

    const upgraded = server.upgrade(req, { data });
    if (!upgraded) {
        try { upstream.close(); } catch { /* best effort */ }
        return false;
    }

    upstream.addEventListener('open', () => {
        data.upstreamOpen = true;
        // Drain client → upstream.
        for (const frame of data.pendingToUpstream) {
            try { upstream.send(frame); } catch { /* ignore */ }
        }
        data.pendingToUpstream.length = 0;
        // Drain upstream → client only if the client ws is already
        // live. If not, `open(ws)` below will handle it when ws opens.
        maybeDrainToClient(data);
    });

    upstream.addEventListener('message', (ev) => {
        // Normalize ArrayBuffer / Blob / string into what
        // ServerWebSocket.send accepts. Blob shouldn't appear over a
        // Node-side upstream but guard anyway.
        const payload = normalizeIncoming(ev.data);
        if (data.clientWs && data.clientWs.readyState === 1) {
            try { data.clientWs.send(payload); } catch { /* ignore */ }
        } else {
            data.pendingToClient.push(payload);
        }
    });

    upstream.addEventListener('close', (ev) => {
        try { data.clientWs?.close(ev.code, ev.reason); } catch { /* best effort */ }
    });

    upstream.addEventListener('error', () => {
        opts.logger.warn({ event: 'gateway.upstream.error' });
        try { data.clientWs?.close(1011, 'upstream error'); } catch { /* best effort */ }
    });

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
            ws.data.clientWs = ws;
            // Drain anything that arrived from upstream while the
            // client side was still upgrading.
            maybeDrainToClient(ws.data);
        },
        message(ws: ServerWebSocket<ClientData>, message: string | Buffer) {
            const frame = normalizeIncoming(message);
            if (ws.data.upstreamOpen) {
                try { ws.data.upstream.send(frame); } catch { /* ignore */ }
            } else {
                ws.data.pendingToUpstream.push(frame);
            }
        },
        close(ws: ServerWebSocket<ClientData>, code: number, reason: string) {
            try { ws.data.upstream.close(code, reason); } catch { /* best effort */ }
        },
    };
}

function maybeDrainToClient(data: ClientData): void {
    if (!data.upstreamOpen) return;
    if (!data.clientWs || data.clientWs.readyState !== 1) return;
    for (const frame of data.pendingToClient) {
        try { data.clientWs.send(frame); } catch { /* ignore */ }
    }
    data.pendingToClient.length = 0;
}

function normalizeIncoming(
    input: string | ArrayBuffer | Blob | Buffer | Uint8Array,
): string | ArrayBufferLike {
    if (typeof input === 'string') return input;
    if (input instanceof ArrayBuffer) return input;
    // Buffer / Uint8Array — slice out the backing ArrayBuffer view.
    if ((input as Uint8Array).byteLength !== undefined) {
        const view = input as Uint8Array;
        return view.buffer.slice(
            view.byteOffset,
            view.byteOffset + view.byteLength,
        ) as ArrayBufferLike;
    }
    // Blob: unexpected on the upstream side; treat as empty string.
    return '';
}
