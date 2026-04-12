// ── Schema DSL ──────────────────────────────────────────────────────────────
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
    isTable,
    isView,
} from './schema';
export type {
    Table,
    TableMetadata,
    AnyTable,
    ColumnDef,
    ColumnKind,
    ColumnRef,
    ViewBuilder,
    Operator,
    AggDef,
    MergeStrategy,
    Monotonicity,
    InferRecord,
    NumericKeys,
} from './schema';

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
export { channel, buildChannelRouting, resolvePublishSubjects } from './channels';
export type {
    ChannelConfig,
    ChannelNames,
    ChannelSubject,
    ChannelRouting,
    RoutableMessage,
} from './channels';

// ── NATS ACL (pure helper, no caller wired in Phase 2.5) ──────────────────
export { generateNatsPermissions } from './nats-acl';
export type { RoleSpec, Roles, NatsPermissions } from './nats-acl';

// ── Entity DSL (Phase 4 — actor model on Restate virtual objects) ─────────
export {
    entity,
    defineEntity,
    isEntity,
    validateEntityState,
    applyHandler,
    rebase,
    emit,
    extractEmits,
    EMIT_KEY,
    sourceSum,
    sourceCount,
    sourceMin,
    sourceMax,
    buildSourceInitial,
    mergeSourceIntoState,
    pickUserState,
    applySourceDeltas,
} from './entity';

// ── Project config (PLAN Phase 8 — workspace resolution) ─────────────────
export { config, defineConfig } from './config';
export type {
    SyncengineConfig,
    SyncengineUser,
    WorkspacesConfig,
    WorkspaceResolveContext,
} from './config';
export type {
    EmitInsert,
    SourceProjectionDef,
    SourceProjections,
    EntityDef,
    AnyEntity,
    EntityState,
    EntityStateShape,
    EntityHandler,
    EntityHandlerMap,
    EntityRecord,
    EntityHandlers,
    PendingActionLike,
    RebaseResult,
} from './entity';

// ── Topic DSL (ephemeral pub/sub over NATS core) ────────────────────────────
export { topic, isTopic } from './topic';
export type { TopicDef, AnyTopic, TopicRecord } from './topic';

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

// ── HTTP helpers (shared between vite-plugin dev + production server) ───────
// Exported via subpath `@syncengine/core/http` (not the main barrel)
// because they depend on `node:crypto`, which breaks browser-only
// consumers like `@syncengine/client`. Import as:
//   import { hashWorkspaceId } from '@syncengine/core/http';

// ── Constants ───────────────────────────────────────────────────────────────
export * from './constants';
