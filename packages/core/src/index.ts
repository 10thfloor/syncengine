// ── Schema ──────────────────────────────────────────────────────────────────
export {
    table,
    id,
    integer,
    real,
    text,
    boolean,
    view,
    sum,
    count,
    avg,
    min,
    max,
    extractMergeConfig,
} from './schema';
export type { TableDef, ViewDef, MergeStrategy, Monotonicity } from './schema';

// ── Connection / status (user-facing subset of the protocol types) ────────
// SyncConfig itself is no longer user-facing — it lives in
// @syncengine/core/internal and is threaded through by the framework via
// virtual:syncengine/runtime-config. But the UI still needs to read the
// connection + sync phase, so those stay on the public surface.
export type {
    ConnectionStatus,
    SyncStatus,
    ConflictRecord,
} from './internal/sync-types';

// ── Channels (user-facing access control boundaries) ──────────────────────
export { buildChannelRouting, resolvePublishSubjects } from './channels';
export type { ChannelConfig, ChannelRouting, RoutableMessage } from './channels';

// ── HLC ─────────────────────────────────────────────────────────────────────
export { hlcTick, hlcMerge, hlcPack, hlcCompare } from './hlc';
export type { HLCState } from './hlc';

// ── Migrations ──────────────────────────────────────────────────────────────
export {
    migrationStepToSQL,
    migrationToSQL,
    validateMigration,
    validateMigrationStep,
} from './migrations';
export type { Migration, MigrationStep } from './migrations';

// ── SQL generation ──────────────────────────────────────────────────────────
export {
    tableToCreateSQL,
    tableToInsertSQL,
    escapeIdentifier,
    escapeLiteral,
} from './sql-gen';

// ── Constants ───────────────────────────────────────────────────────────────
export * from './constants';
