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

// ── Event bus dispatcher (Phase 1, Task 7) ─────────────────────────────────
// Durable JetStream consumer → Restate ingress, with DLQ on terminal error.
// See `bus-dispatcher.ts` for the retry-ownership contract.
export { BusDispatcher, postToRestate } from './bus-dispatcher';
export type { BusDispatcherConfig } from './bus-dispatcher';
export { retryToBackoffArray } from './bus-backoff';
export type { BackoffSchedule } from './bus-backoff';
export { cursorToDeliverPolicy } from './bus-cursor';
export type { CursorConfig } from './bus-cursor';
export { publishDeadEvent } from './bus-dlq';
export { connectNats } from './nats-connect';
