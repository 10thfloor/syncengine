import { connect as tcpConnect, wsconnect, type NatsConnection } from '@nats-io/transport-node';

/**
 * Open a NATS connection, choosing transport by URL scheme. `ws://`
 * and `wss://` use the WebSocket transport (works in Bun, browsers,
 * and Node); `nats://` / bare host:port use the raw TCP transport.
 *
 * The callers used to pre-translate ws:// → nats:// themselves, which
 * pushed a transport concern into every boot path and only worked
 * when the server happened to expose both listeners on predictable
 * ports. Centralising here keeps `syncengine.config` URLs unambiguous.
 */
export async function connectNats(url: string): Promise<NatsConnection> {
    const scheme = url.split(':', 1)[0]?.toLowerCase() ?? '';
    if (scheme === 'ws' || scheme === 'wss') {
        return wsconnect({ servers: url });
    }
    return tcpConnect({ servers: url });
}
