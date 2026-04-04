// ── Re-export schema DSL and types from core for convenience ─────────────
// So consumers can `import { store, table, id, ... } from '@syncengine/client'`
// without also importing from '@syncengine/core'.
export * from '@syncengine/core';

// ── Store (React hooks + worker wiring) ──────────────────────────────────
export { store, validateStoreConfig } from './store';
export type {
    Store,
    StoreConfig,
    SeedMap,
    UseResult,
    ConnectionStatus,
    SyncStatus,
    ConflictRecord,
} from './store';

// ── React provider ───────────────────────────────────────────────────────
export { StoreProvider, useStore } from './react';
export type { StoreProviderProps } from './react';

// ── Entity client (Phase 4 — actor model on Restate virtual objects) ─────
export { useEntity } from './entity-client';
export type { UseEntityResult, ActionMap } from './entity-client';
