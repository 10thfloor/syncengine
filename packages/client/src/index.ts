// ── Re-export schema DSL and types from core for convenience ─────────────
// So consumers can `import { store, table, id, ... } from '@syncengine/client'`
// without also importing from '@syncengine/core'.
export * from '@syncengine/core';

// ── Store (React hooks + worker wiring) ──────────────────────────────────
export { store } from './store';
export type {
    Store,
    StoreConfig,
    // Re-exported from core via store.ts for backward compat
    SyncConfig,
    ConnectionStatus,
    SyncStatus,
    ConflictRecord,
} from './store';
