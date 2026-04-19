// ── Error System ────────────────────────────────────────────────────────────
export {
    SyncEngineError,
    UserHandlerError,
    errors,
    formatError,
    SchemaCode,
    EntityCode,
    StoreCode,
    ConnectionCode,
    HandlerCode,
    CliCode,
} from './errors';

export type {
    ErrorCategory,
    ErrorSeverity,
    ErrorOpts,
    SyncEngineErrorInit,
    SchemaCodeValue,
    EntityCodeValue,
    StoreCodeValue,
    ConnectionCodeValue,
    HandlerCodeValue,
    CliCodeValue,
} from './errors';

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
    GLOBAL_AGG_KEY,
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

// ── Service DSL (hex architecture — driven ports) ────────────────────────
export { service, isService, override, isServiceOverride } from './service';
export type { ServiceDef, ServicePort, ServiceName, AnyService, ServiceOverride, AnyServiceOverride } from './service';

// ── Entity DSL (Phase 4 — actor model on Restate virtual objects) ─────────
export {
    entity,
    defineEntity,
    isEntity,
    validateEntityState,
    applyHandler,
    rebase,
    emit,
    insert,
    trigger,
    extractEmits,
    extractTriggers,
    EMIT_KEY,
    TRIGGER_KEY,
    sourceSum,
    sourceCount,
    sourceMin,
    sourceMax,
    buildSourceInitial,
    mergeSourceIntoState,
    pickUserState,
    applySourceDeltas,
    EntityError,
    getTerminalStates,
    getTransitionGraph,
} from './entity';

// ── Project config (PLAN Phase 8 — workspace resolution) ─────────────────
export { config, defineConfig } from './config';
export type {
    SyncengineConfig,
    SyncengineUser,
    WorkspacesConfig,
    WorkspaceResolveContext,
    AuthConfig,
    AuthVerifyContext,
    ServicesConfig,
} from './config';
export type {
    EmitInsert,
    EmitTrigger,
    TypedEmitInsert,
    LegacyEmitInsert,
    SourceProjectionDef,
    SourceProjections,
    SourceState,
    TransitionMap,
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

// ── Workspace signal (user-facing workspace lifecycle state) ────────────────
export type WorkspaceStatus = 'switching' | 'provisioning' | 'connecting' | 'replaying' | 'live' | 'error';

export interface WorkspaceInfo {
    readonly wsKey: string;
    readonly status: WorkspaceStatus;
    readonly error?: string;
}

// ── Workflow tag (minimal type for client-side references) ──────────────────
/** Minimal structural type for workflow definitions. Used by the client
 *  store's `runWorkflow()` without importing `@syncengine/server`. */
export interface AnyWorkflowDef {
    readonly $tag: 'workflow';
    readonly $name: string;
}

// ── Topic DSL (ephemeral pub/sub over NATS core) ────────────────────────────
export { topic, isTopic } from './topic';
export type { TopicDef, AnyTopic, TopicRecord } from './topic';

// ── Heartbeat framework status entity ──────────────────────────────────────
// Framework-owned; users interact through `useHeartbeat(def)` on the client
// or `heartbeat()` on the server. Exported here so both sides can reference
// the same entity definition without pulling in each other's deps.
export { heartbeatStatus, HEARTBEAT_STATUS_ENTITY_NAME, heartbeatStatusKey } from './heartbeat-status';

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

// ── Duration + Bytes branded factories ──────────────────────────────────────
// Dimensional values for bus / JetStream config. Plain numbers are rejected
// at the type level so `retention: days(30)` is the only path to correctness.
export { milliseconds, seconds, minutes, hours, days } from './duration';
export type { Duration } from './duration';
export { bytes } from './bytes';
export type { Bytes } from './bytes';

// ── Bus config factory namespaces ──────────────────────────────────────────
export { Retention, Delivery, Storage, Retry, Backoff } from './bus-config';
export type {
    RetentionConfig,
    DeliveryConfig,
    DeliveryMode,
    StorageConfig,
    StorageKind,
    RetryConfig,
    BackoffConfig,
} from './bus-config';

// ── bus() primitive ────────────────────────────────────────────────────────
export { bus, isBus, deadEventSchema, setBusPublisher } from './bus';
export type {
    BusRef,
    BusOptions,
    BusConfig,
    BusPublishCtx,
    BusPublisher,
    DeadEvent,
} from './bus';
