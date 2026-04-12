// packages/server/src/gateway/standalone.ts
import { GatewayServer } from './server.js';

const PORT = parseInt(process.env.PORT ?? '9333', 10);
const NATS_URL = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
const RESTATE_URL = process.env.SYNCENGINE_RESTATE_URL ?? 'http://localhost:8080';

const gateway = new GatewayServer({ natsUrl: NATS_URL, restateUrl: RESTATE_URL });
gateway.listen(PORT);

process.on('SIGTERM', async () => { await gateway.shutdown(); process.exit(0); });
process.on('SIGINT', async () => { await gateway.shutdown(); process.exit(0); });
