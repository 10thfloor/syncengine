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

// ── Sync types (protocol contracts) ────────────────────────────────────────
export type {
    SyncConfig,
    ConnectionStatus,
    SyncStatus,
    ConflictRecord,
} from './sync-types';

// ── Channels ────────────────────────────────────────────────────────────────
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
