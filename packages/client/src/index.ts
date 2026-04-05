// ── Re-export schema DSL and types from core for convenience ─────────────
// So consumers can `import { store, table, id, ... } from '@syncengine/client'`
// without also importing from '@syncengine/core'.
export * from '@syncengine/core';

// ── Store (React hooks + worker wiring) ──────────────────────────────────
export { store } from './store';
export type {
    Store,
    StoreConfig,
    ConnectionStatus,
    SyncStatus,
    ConflictRecord,
} from './store';
// SyncConfig is no longer user-facing — the framework threads NATS URLs
// and workspace IDs through `virtual:syncengine/runtime-config` internally.
