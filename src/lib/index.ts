// ── Schema ──────────────────────────────────────────────────────────────────
export { table, id, integer, real, text, boolean, view, sum, count, avg, min, max, extractMergeConfig } from './schema';
export type { TableDef, ViewDef, MergeStrategy, Monotonicity } from './schema';

// ── Store ───────────────────────────────────────────────────────────────────
export { store } from './store';
export type { Store, StoreConfig, SyncConfig, ConnectionStatus, SyncStatus, ConflictRecord } from './store';

// ── HLC ─────────────────────────────────────────────────────────────────────
export { hlcTick, hlcMerge, hlcPack, hlcCompare } from './hlc';
export type { HLCState } from './hlc';

// ── Migrations ──────────────────────────────────────────────────────────────
export { migrationStepToSQL, migrationToSQL, validateMigration, validateMigrationStep } from './migrations';
export type { Migration, MigrationStep } from './migrations';

// ── SQL generation ──────────────────────────────────────────────────────────
export { tableToCreateSQL, tableToInsertSQL, escapeIdentifier, escapeLiteral } from './sql-gen';

// ── Constants ───────────────────────────────────────────────────────────────
export * from './constants';
