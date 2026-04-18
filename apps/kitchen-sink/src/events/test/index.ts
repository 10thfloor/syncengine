// ── Test-env bus overrides ──────────────────────────────────────────────────
//
// Wired in via `syncengine.config.ts`'s
// `services.overrides: () => import('./events/test')` when
// NODE_ENV === 'test'. The overrides file exists but is never imported
// in production — the config guards the dynamic import on the env flag.
//
// Purpose: let integration tests that boot the full app (RPC + HTTP) run
// without a NATS broker by flipping the `orderEvents` bus to in-memory
// mode. Subscribers fire inline; DLQ still works; no docker required.

import { override, BusMode } from '@syncengine/core';
import { orderEvents } from '../orders.bus';

export default [
    override(orderEvents, { mode: BusMode.inMemory() }),
];
