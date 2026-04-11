// ── Gateway connection factory ───────────────────────────────────────────────
//
// Shared WebSocket handshake used by entity-client.ts (main thread) and
// data-worker.js (worker thread). Handles the open → init → ready lifecycle,
// then hands off to the caller's onMessage callback.

export interface GatewayConnectionConfig {
    url: string;
    workspaceId: string;
    channels: string[];
    clientId: string;
    authToken?: string;
    onMessage: (msg: Record<string, unknown>) => void;
    onClose?: () => void;
}

/**
 * Open a gateway WebSocket and perform the init/ready handshake.
 * Resolves with the open WebSocket after the server sends 'ready'.
 * The onMessage callback receives all subsequent messages.
 *
 * The factory sets ws.onmessage to the permanent handler inside the ready
 * callback, so any messages arriving after ready go straight to onMessage
 * with no ordering gap.
 *
 * The ws.onerror handler rejects the promise; the caller's catch block is
 * responsible for reconnection.
 */
export function connectToGateway(config: GatewayConnectionConfig): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(config.url);
        let settled = false;

        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: 'init',
                workspaceId: config.workspaceId,
                channels: config.channels,
                clientId: config.clientId,
                authToken: config.authToken || undefined,
            }));
        };

        // Temporary handler for the handshake phase only.
        ws.onmessage = (event: MessageEvent) => {
            const msg = JSON.parse(
                typeof event.data === 'string' ? event.data : String(event.data),
            ) as Record<string, unknown>;
            if (msg['type'] === 'ready') {
                settled = true;
                // Switch to the permanent message handler before resolving so
                // messages that arrive immediately after ready are not lost.
                ws.onmessage = (e: MessageEvent) => {
                    config.onMessage(
                        JSON.parse(
                            typeof e.data === 'string' ? e.data : String(e.data),
                        ) as Record<string, unknown>,
                    );
                };
                resolve(ws);
            } else if (msg['type'] === 'error') {
                settled = true;
                reject(new Error(typeof msg['message'] === 'string' ? msg['message'] : 'Gateway error'));
            }
        };

        ws.onerror = () => {
            if (!settled) { settled = true; reject(new Error('Gateway connection failed')); }
        };
        // Only fire onClose for established connections — during the handshake
        // phase, the catch block in the caller handles reconnection. Without
        // this guard, both onerror (→ catch) and onclose (→ onClose callback)
        // would schedule reconnect timers, doubling on every failure.
        ws.onclose = () => { if (settled) config.onClose?.(); };
    });
}
