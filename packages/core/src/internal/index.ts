/**
 * Internal barrel — types consumed by the client runtime and worker but
 * NOT part of the user-facing API. Imported via `@syncengine/core/internal`.
 *
 * Phase 3 moved these out of the public barrel because the user no longer
 * needs to think about NATS URLs, workspace IDs, or auth tokens — the
 * framework threads them through via `virtual:syncengine/runtime-config`.
 */

export type {
    SyncConfig,
    ConnectionStatus,
    SyncStatus,
    ConflictRecord,
} from './sync-types';
