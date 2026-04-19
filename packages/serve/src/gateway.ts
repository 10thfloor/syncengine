/**
 * Bun `ServerWebSocket`-backed adapter over `@syncengine/gateway-core`.
 *
 * The edge binary owns the `/gateway` WebSocket in-process — no
 * upstream proxy, no separate gateway service. Inbound upgrade is
 * recognized in `server.ts`, hijacked via `server.upgrade()`, and
 * frames flow to GatewayCore the same way the Node bundle routes
 * them through `ws`.
 *
 * Session state lives on the per-connection data Bun carries via
 * `server.upgrade(req, { data })`. We stash the GatewayCore session
 * handle there so the websocket callbacks can dispatch directly.
 */

import type { ServerWebSocket } from 'bun';
import {
    GatewayCore,
    type GatewayClientWs,
    type GatewayConfig,
    type GatewaySessionHandle,
} from '@syncengine/gateway-core';

// Bun's `server.upgrade(req, { data })` is the only method we need.
type BunServerForUpgrade = {
    upgrade: <T>(req: Request, opts: { data: T }) => boolean;
};

type SessionData = {
    /** Set synchronously during upgrade so the session outlives the
     *  closure. Filled with a live handle before open() fires. */
    readonly session: GatewaySessionHandle;
    /** The live Bun ws is back-published here by the `open` callback
     *  so the adapter's `send`/`close`/`isOpen` methods can reach it
     *  without a closure capture. */
    ws: ServerWebSocket<SessionData> | null;
};

export class BunGateway {
    private readonly core: GatewayCore;

    constructor(config: GatewayConfig) {
        this.core = new GatewayCore(config);
    }

    /**
     * Try to upgrade a `/gateway` request. Returns true if handled
     * (either upgraded or rejected), false to let the caller fall
     * through to its normal handlers.
     */
    tryUpgrade(req: Request, server: BunServerForUpgrade): boolean {
        if (new URL(req.url).pathname !== '/gateway') return false;

        // Construct an adapter first, then attach to GatewayCore, then
        // upgrade. If upgrade fails, detach the session cleanly.
        const data: SessionData = {
            session: null as unknown as GatewaySessionHandle,
            ws: null,
        };
        const adapter: GatewayClientWs = {
            send: (msg) => {
                if (data.ws && data.ws.readyState === 1) data.ws.send(msg);
            },
            close: (code, reason) => {
                try { data.ws?.close(code, reason); } catch { /* best effort */ }
            },
            get isOpen() {
                return !!data.ws && data.ws.readyState === 1;
            },
        };
        (data as { session: GatewaySessionHandle }).session = this.core.attach(adapter);

        const upgraded = server.upgrade(req, { data });
        if (!upgraded) {
            data.session.handleClose();
            return false;
        }
        return true;
    }

    /**
     * Bun websocket handler tuple. Plug into
     * `Bun.serve({ websocket: bunGateway.websocketHandlers() })`.
     */
    websocketHandlers() {
        return {
            open: (ws: ServerWebSocket<SessionData>) => {
                ws.data.ws = ws;
            },
            message: (
                ws: ServerWebSocket<SessionData>,
                message: string | Buffer,
            ) => {
                void ws.data.session.handleMessage(
                    typeof message === 'string' ? message : message.toString(),
                );
            },
            close: (ws: ServerWebSocket<SessionData>) => {
                ws.data.session.handleClose();
            },
        };
    }

    async shutdown(): Promise<void> {
        await this.core.shutdown();
    }
}
