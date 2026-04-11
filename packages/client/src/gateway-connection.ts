// ── Gateway connection factory ───────────────────────────────────────────────
//
// Shared WebSocket handshake used by entity-client.ts (main thread) and
// data-worker.js (worker thread). Handles the open → init → ready lifecycle,
// then hands off to the caller's onMessage callback.

/** Known server message types. Validated at the JSON.parse boundary. */
const SERVER_MSG_TYPES = new Set([
    'ready', 'error', 'delta', 'entity-write', 'entity-state',
    'authority', 'topic', 'gc', 'replay-end', 'workspace-registry',
]);

function isValidServerMsg(msg: unknown): msg is Record<string, unknown> & { type: string } {
    if (typeof msg !== 'object' || msg === null) return false;
    const obj = msg as Record<string, unknown>;
    return typeof obj['type'] === 'string' && SERVER_MSG_TYPES.has(obj['type'] as string);
}

export interface GatewayConnectionConfig {
    url: string;
    workspaceId: string;
    channels: string[];
    clientId: string;
    authToken?: string;
    onMessage: (msg: Record<string, unknown> & { type: string }) => void;
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
            const raw: unknown = JSON.parse(
                typeof event.data === 'string' ? event.data : String(event.data),
            );
            if (!isValidServerMsg(raw)) return;
            if (raw['type'] === 'ready') {
                settled = true;
                // Switch to the permanent message handler before resolving so
                // messages that arrive immediately after ready are not lost.
                ws.onmessage = (e: MessageEvent) => {
                    const parsed: unknown = JSON.parse(
                        typeof e.data === 'string' ? e.data : String(e.data),
                    );
                    if (isValidServerMsg(parsed)) {
                        config.onMessage(parsed);
                    }
                };
                resolve(ws);
            } else if (raw['type'] === 'error') {
                settled = true;
                reject(new Error(typeof raw['message'] === 'string' ? raw['message'] : 'Gateway error'));
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
