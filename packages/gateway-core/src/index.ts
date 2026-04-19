// ── @syncengine/gateway-core ──────────────────────────────────────────────
//
// Framework-agnostic WebSocket↔NATS bridge. Consumers (Node `ws`,
// Bun `ServerWebSocket`) adapt their transport through the
// `GatewayClientWs` interface and drive a session via the
// `GatewaySessionHandle` returned from `GatewayCore.attach()`.

export { GatewayCore } from './gateway-core';
export type { GatewayConfig, GatewaySessionHandle } from './gateway-core';
export { ClientSession } from './client-session';
export type { GatewayClientWs } from './client-session';
export { WorkspaceBridge } from './workspace-bridge';
export type { BridgeConfig } from './workspace-bridge';
export { RingBuffer } from './ring-buffer';
export { isValidClientMsg } from './protocol';
export type {
    ClientMsg,
    ClientInitMessage,
    ServerMsg,
} from './protocol';
