// Node adapter entry — re-exports the Node-specific GatewayServer and
// passes the gateway-core types through so callers who previously
// imported from `@syncengine/server/gateway` keep working.

export { GatewayServer, type GatewayConfig } from './server.js';
export {
    WorkspaceBridge,
    ClientSession,
    RingBuffer,
    type BridgeConfig,
} from '@syncengine/gateway-core';
export type {
    ClientMsg,
    ClientInitMessage,
    ServerMsg,
} from '@syncengine/gateway-core';
