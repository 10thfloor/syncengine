// ── Entity DSL (Phase 4) ────────────────────────────────────────────────────
//
// `defineEntity` declares a typed actor: a single piece of state with a set
// of pure-functional handlers that mutate it. At runtime each entity TYPE
// becomes a Restate virtual object on the server, and each entity INSTANCE
// (identified by a key string) is a separately-keyed virtual-object instance
// with its own isolated state.
//
// Entities are for state where you need a SINGLE WRITER — atomic counters,
// checkout flows, distributed locks, billing-relevant numbers, etc. For
// CRDT-replicated bag-of-rows data, keep using `table()` instead.
//
// Design rules:
//
// 1. Handlers are pure: `(state, ...args) => newState`. Mutating `state`
//    in place is undefined behavior — return a new object. Pure handlers
//    are trivially testable, serializable, and (in a future phase) runnable
//    client-side for latency compensation.
//
// 2. State columns reuse the existing `ColumnDef` from `schema.ts` so an
//    entity's state shape gets the same SQL type / enum / nullable knobs
//    as a table column. The `id` and `merge` fields are unused for entities
//    but harmless — entity state has no primary key (the entity KEY is the
//    PK) and is never CRDT-merged (single-writer).
//
// 3. The user writes the entity definition once in `src/entities.ts`. The
//    framework imports the same file from both client (typed React hook)
//    and server (Restate object factory). No codegen, no IDL.

import type { ColumnDef, ColumnRef, InferRecord, AnyTable } from "./schema";
import { errors, SchemaCode, EntityCode, HandlerCode, SyncEngineError } from './errors';

// ── EntityError ──────────────────────────────────────────────────────────────

/**
 * Public user-facing error class for DOMAIN errors thrown from entity
 * handlers. Modeled on Meteor.Error:
 *
 *     if (state.stock <= 0) {
 *         throw new EntityError('OUT_OF_STOCK', 'No stock available');
 *     }
 *
 * `applyHandler` propagates EntityError unchanged so callers can
 * pattern-match on `.code` to distinguish domain failures from framework
 * failures.
 *
 * ⚠️  ORTHOGONAL to the platform error system (`SyncEngineError`,
 * `errors.*`, code registries). The platform system is a framework →
 * developer diagnostic — "this is what syncengine broke". EntityError is
 * a user → user contract — "this is what my app's domain rejected". Keep
 * them separate.
 */
export class EntityError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'EntityError';
        this.code = code;
    }
}

// ── Transition map ──────────────────────────────────────────────────────────

/** Transition adjacency map: from-state → allowed to-states.
 *  Terminal states have empty arrays. Used by the framework to
 *  auto-guard handler results — no manual guardTransition() needed. */
export type TransitionMap = Record<string, readonly string[]>;

// ── State shape ─────────────────────────────────────────────────────────────

/** Map from state field name to its `ColumnDef`. Reuses the schema DSL so
 *  `text`, `integer`, `boolean` etc. work the same way as on tables. */
export type EntityStateShape = Record<string, ColumnDef<unknown>>;

/** The runtime record type inferred from a state shape. Drives every
 *  handler's `state` parameter and the `useEntity()` return type. */
export type EntityState<TShape extends EntityStateShape> = InferRecord<TShape>;

// ── Handler types ───────────────────────────────────────────────────────────

/**
 * A handler is a pure function from `(state, ...args)` to a new state.
 *
 * Args can be any number of JSON-serializable values; the framework
 * encodes them in the wire request. Returning a partial state is allowed —
 * the framework merges the returned object into the existing state, so
 * handlers can `return { count: state.count + 1 }` instead of spreading
 * the whole record. (Use `return { ...state, count: ... }` if you prefer
 * the explicit form; both work.)
 *
 * Handlers may throw to reject the call; Restate's transactional model
 * leaves state unchanged on throw.
 */
export type EntityHandler<
  TState,
  TArgs extends readonly unknown[] = readonly unknown[],
> = (state: TState, ...args: TArgs) => TState | Partial<TState>;

/** A bag of handlers keyed by name. */
export type EntityHandlerMap<TState> = Record<
  string,
  EntityHandler<TState, readonly never[]>
>;

// ── Source state mapping ───────────────────────────────────────────────────

/** Maps source projection key names to their runtime type (always number). */
export type SourceState<TKeys extends string> = { readonly [K in TKeys]: number };

// ── Entity definition ──────────────────────────────────────────────────────

/**
 * The output of `defineEntity(...)`. Carries the typed state shape and
 * handler map under `$`-prefixed keys (matching the table/view convention),
 * plus a runtime `$validate` helper used by the server to type-check
 * handler return values before persisting.
 */
export interface EntityDef<
  TName extends string,
  TShape extends EntityStateShape,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  THandlers extends EntityHandlerMap<any>,
  TSourceKeys extends string = never,
> {
  readonly $tag: "entity";
  readonly $name: TName;
  readonly $state: TShape;
  readonly $handlers: THandlers;
  /** Initial state — every column's default applied. Used the first time
   *  an entity instance is read before any handler has run. */
  readonly $initialState: EntityState<TShape>;
  /** Source projection definitions (Variation D). Empty if no `source`
   *  was declared on the entity. */
  readonly $source: SourceProjections;
  /** Initial projection values (sum/count → 0, min → Infinity, etc.) */
  readonly $sourceInitial: Record<string, number>;
  /** Transition adjacency map: from-state → allowed to-states.
   *  null if no transitions declared on this entity. */
  readonly $transitions: TransitionMap | null;
  /** The state field governed by `$transitions`. null if no transitions. */
  readonly $statusField: string | null;
  /** Phantom field carrying the inferred state record type for callers
   *  that want `EntityRecord<typeof cart>` without re-deriving it. */
  readonly $record: EntityState<TShape>;
  /** Phantom: source projection key names, used to type the merged state. */
  readonly $sourceKeys: TSourceKeys;
}

/** Type-level shortcut: extract the state record type from an EntityDef,
 *  including source projection fields (always `number`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EntityRecord<E> =
  E extends EntityDef<string, infer TShape, any, infer TKeys>
    ? EntityState<TShape> & SourceState<TKeys>
    : never;

/** Type-level shortcut: extract the handler map from an EntityDef. */
export type EntityHandlers<E> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  E extends EntityDef<string, EntityStateShape, infer THandlers, string>
    ? THandlers
    : never;

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a candidate state record against an entity's shape. Throws on
 * the first violation; returns the validated record on success. Used by
 * the server's entity-runtime to guard handler outputs before persisting.
 *
 * Rules enforced:
 *   - every required (non-nullable) column is present
 *   - every present column matches the declared SQL type's JS shape
 *     (number, string, boolean — DBSP's column types are SQL-flavored
 *     but the JS values are plain primitives)
 *   - if the column declares an `enum`, the value is one of the listed
 *     literals
 */
export function validateEntityState<TShape extends EntityStateShape>(
  shape: TShape,
  record: Record<string, unknown>,
  entityName = "<entity>",
): EntityState<TShape> {
  const out: Record<string, unknown> = {};
  for (const [name, col] of Object.entries(shape)) {
    const value = record[name];
    if (value === undefined || value === null) {
      if (col.nullable) {
        out[name] = null;
        continue;
      }
      throw errors.entity(EntityCode.MISSING_REQUIRED_FIELD, {
        message: `Entity '${entityName}': column '${name}' is required but missing.`,
        hint: `Ensure your handler returns a value for '${name}'.`,
        context: { entity: entityName, field: name },
      });
    }
    const expectedType = jsTypeForKind(col.kind);
    if (expectedType && typeof value !== expectedType) {
      throw errors.entity(EntityCode.TYPE_MISMATCH, {
        message:
          `Entity '${entityName}': column '${name}' expects ${expectedType}, ` +
          `got ${typeof value} (${JSON.stringify(value)}).`,
        hint: `Return the correct type from your handler.`,
        context: { entity: entityName, field: name, expected: expectedType, got: typeof value },
      });
    }
    if (col.enum && !col.enum.includes(value as never)) {
      throw errors.entity(EntityCode.ENUM_VIOLATION, {
        message:
          `Entity '${entityName}': column '${name}' must be one of ` +
          `${JSON.stringify(col.enum)}, got ${JSON.stringify(value)}.`,
        hint: `Return one of the allowed enum values.`,
        context: { entity: entityName, field: name, allowed: col.enum, got: value },
      });
    }
    out[name] = value;
  }
  return out as EntityState<TShape>;
}

export function jsTypeForKind(
  kind: import("./schema").ColumnKind,
): "string" | "number" | "boolean" | null {
  switch (kind) {
    case "id":
    case "integer":
    case "real":
      return "number";
    case "text":
      return "string";
    case "boolean":
      return "boolean";
    default:
      return null;
  }
}

// ── Initial state ──────────────────────────────────────────────────────────

/**
 * Build the default state record for an entity from its column definitions.
 * Numbers default to 0, strings to '', booleans to false. Nullable columns
 * default to null. The first read of any entity instance returns this
 * record, before any handler has run.
 */
export function buildInitialState<TShape extends EntityStateShape>(
  shape: TShape,
): EntityState<TShape> {
  const out: Record<string, unknown> = {};
  for (const [name, col] of Object.entries(shape)) {
    if (col.nullable) {
      out[name] = null;
      continue;
    }
    const type = jsTypeForKind(col.kind);
    if (type === "number") out[name] = 0;
    else if (type === "string") out[name] = col.enum ? col.enum[0] : "";
    else if (type === "boolean") out[name] = false;
    else out[name] = null;
  }
  return out as EntityState<TShape>;
}

// ── defineEntity ────────────────────────────────────────────────────────────

/**
 * Declare an entity type. Pass the entity's `name` (used as the Restate
 * object name and the NATS subject infix), its `state` shape, and a map
 * of pure-functional handlers.
 *
 * Example:
 *
 *     const counter = defineEntity('counter', {
 *         state: { value: integer() },
 *         handlers: {
 *             increment(state, by: number) {
 *                 return { value: state.value + by };
 *             },
 *             reset() {
 *                 return { value: 0 };
 *             },
 *         },
 *     });
 *
 * The handler map's key (`'increment'`, `'reset'`) is the wire-format
 * handler name. Each handler receives the current state and any args
 * passed by the caller; it returns a new state (or a partial state to
 * merge in). The first argument is always `state` and is passed by
 * the framework — the caller's args start at index 1.
 */
export { entity as defineEntity };

export function entity<
  const TName extends string,
  TShape extends EntityStateShape,
  const TSourceDef extends Record<string, SourceProjectionDef> = Record<never, SourceProjectionDef>,
  THandlers extends EntityHandlerMap<EntityState<TShape> & SourceState<Extract<keyof TSourceDef, string>>> = EntityHandlerMap<EntityState<TShape> & SourceState<Extract<keyof TSourceDef, string>>>,
>(
  name: TName,
  config: {
    readonly state: TShape;
    readonly source?: TSourceDef;
    readonly transitions?: Record<string, readonly string[]>;
    readonly handlers: THandlers;
  },
): EntityDef<TName, TShape, THandlers, Extract<keyof TSourceDef, string>> {
  // Runtime guards: catch the easy mistakes at construction time so the
  // user sees them on import, not on first handler call.
  if (!name || typeof name !== "string") {
    throw errors.schema(SchemaCode.INVALID_ENTITY_NAME, {
      message: `defineEntity: name must be a non-empty string.`,
      hint: `Pass a valid name: defineEntity('myEntity', { ... })`,
    });
  }
  if (name.startsWith("$")) {
    throw errors.schema(SchemaCode.INVALID_ENTITY_NAME, {
      message:
        `defineEntity('${name}'): names may not start with '$' ` +
        `(reserved for framework metadata).`,
      hint: `Remove the '$' prefix from the entity name.`,
      context: { entity: name },
    });
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
    throw errors.schema(SchemaCode.INVALID_ENTITY_NAME, {
      message:
        `defineEntity('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/ ` +
        `so it can be used as a Restate object name and a NATS subject token.`,
      hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
      context: { entity: name },
    });
  }
  for (const colName of Object.keys(config.state)) {
    if (colName.startsWith("$")) {
      throw errors.schema(SchemaCode.RESERVED_COLUMN_PREFIX, {
        message:
          `defineEntity('${name}'): state field '${colName}' may not start ` +
          `with '$' (reserved for framework metadata).`,
        hint: `Rename the state field to remove the '$' prefix.`,
        context: { entity: name, field: colName },
      });
    }
  }
  for (const [handlerName, fn] of Object.entries(config.handlers)) {
    if (typeof fn !== "function") {
      throw errors.schema(SchemaCode.HANDLER_NOT_FUNCTION, {
        message: `defineEntity('${name}'): handler '${handlerName}' must be a function.`,
        hint: `Provide a function: handlers: { ${handlerName}(state, ...args) { return newState; } }`,
        context: { entity: name, handler: handlerName },
      });
    }
    // Restate's handler-name regex is ^([a-zA-Z]|_[a-zA-Z0-9])[a-zA-Z0-9_]*$.
    // Names starting with `_` (single underscore + letter/digit) are
    // reserved for the framework's built-in handlers (`_read`, `_init`,
    // any future additions). `$` is reserved for metadata fields.
    if (handlerName.startsWith("_") || handlerName.startsWith("$")) {
      throw errors.schema(SchemaCode.HANDLER_NAME_RESERVED, {
        message:
          `defineEntity('${name}'): handler name '${handlerName}' is reserved ` +
          `(framework uses '_'/'$' prefixes for internal handlers).`,
        hint: `Choose a handler name that doesn't start with '_' or '$'.`,
        context: { entity: name, handler: handlerName },
      });
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(handlerName)) {
      throw errors.schema(SchemaCode.HANDLER_NAME_INVALID, {
        message:
          `defineEntity('${name}'): handler name '${handlerName}' must match ` +
          `/^[a-zA-Z][a-zA-Z0-9_]*$/ (Restate's handler-name regex).`,
        hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
        context: { entity: name, handler: handlerName },
      });
    }
  }

  const source = config.source ?? {};

  // Guard: source projection names must not collide with state field names.
  // The merged state object would silently overwrite one with the other.
  for (const projName of Object.keys(source)) {
    if (projName in config.state) {
      throw errors.schema(SchemaCode.STATE_FIELD_COLLISION, {
        message:
          `defineEntity('${name}'): source projection '${projName}' collides ` +
          `with state field of the same name. Rename one.`,
        hint: `Rename either the state field or the source projection to avoid the collision.`,
        context: { entity: name, field: projName },
      });
    }
  }

  // ── Transition map validation ────────────────────────────────────────────
  const transitions: TransitionMap | null = config.transitions ?? null;
  let statusField: string | null = null;

  if (transitions) {
    // Collect every value mentioned in the map (keys + targets).
    const allValues = new Set(Object.keys(transitions));
    for (const targets of Object.values(transitions)) {
      for (const t of targets) allValues.add(t);
    }

    // Find the state field whose enum is a superset of allValues.
    const candidates: string[] = [];
    for (const [fieldName, col] of Object.entries(config.state)) {
      if (!col.enum) continue;
      const enumSet = new Set(col.enum as string[]);
      if ([...allValues].every((v) => enumSet.has(v))) {
        candidates.push(fieldName);
      }
    }

    if (candidates.length === 0) {
      throw errors.schema(SchemaCode.TRANSITION_NO_MATCH, {
        message:
          `defineEntity('${name}'): transitions values don't match any state ` +
          `field's enum. Ensure a state field has an enum containing all ` +
          `transition states.`,
        context: { entity: name },
      });
    }
    if (candidates.length > 1) {
      throw errors.schema(SchemaCode.TRANSITION_AMBIGUOUS, {
        message:
          `defineEntity('${name}'): transitions map is ambiguous — matches ` +
          `state fields: ${candidates.join(", ")}. Use distinct enums.`,
        hint: `Ensure only one state field has an enum that matches the transition keys.`,
        context: { entity: name, candidates },
      });
    }
    statusField = candidates[0]!;

    // Every enum value must appear as a key (exhaustive).
    const col = config.state[statusField]!;
    const enumValues = col.enum as readonly string[];
    for (const ev of enumValues) {
      if (!(ev in transitions)) {
        throw errors.schema(SchemaCode.TRANSITION_NOT_EXHAUSTIVE, {
          message:
            `defineEntity('${name}'): transitions map is missing state ` +
            `'${ev}'. All enum values of '${statusField}' must be listed ` +
            `(use an empty array for terminal states).`,
          hint: `Add '${ev}' to your transitions map:\n\n  transitions: { ..., ${ev}: [...] }`,
          context: { entity: name, missing: ev, statusField },
        });
      }
    }

    // Target validation is not needed here — the detection step already
    // ensures every value in the transitions map (keys + targets) is in
    // the enum, since we only match fields whose enum ⊇ allValues.
  }

  return {
    $tag: "entity",
    $name: name,
    $state: config.state,
    $handlers: config.handlers,
    $initialState: buildInitialState(config.state),
    $source: source,
    $sourceInitial: buildSourceInitial(source),
    $transitions: transitions,
    $statusField: statusField,
    $record: undefined as never,
    $sourceKeys: undefined as never,
  };
}

// ── Runtime helpers ────────────────────────────────────────────────────────

/** Type guard for any entity definition. */
export function isEntity(x: unknown): x is AnyEntity {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { $tag?: string }).$tag === "entity"
  );
}

// NOTE: an earlier draft exposed a `server<T>(handlers: T): T` identity
// helper as an explicit marker for the Vite plugin's handler-stripping
// transform. It was removed because wrapping handlers in `server(...)`
// broke TypeScript's state-parameter inference inside `defineEntity` —
// the plugin now keys off the `.actor.ts` file extension + the
// `handlers:` property literal inside `defineEntity(...)` calls
// instead, which preserves inference. See the review commit message
// for the full rationale.

// ── emit() — entity → table bridge ──────────────────────────────────────────
//
// `emit(newState, ...inserts)` lets a handler return new state AND declare
// table rows that should be published as INSERT deltas to the sync pipeline.
// The entity runtime extracts the inserts via `extractEmits()`, publishes
// them to NATS, and persists only the clean state (Symbol keys are invisible
// to JSON.stringify so they never leak into Restate's storage).
//
// Handlers stay pure — `emit()` is just a return-value wrapper, not a
// side-effecting call. The framework does the I/O.

/** Well-known Symbol key used to carry emitted table inserts on the
 *  handler's return value. Non-enumerable, invisible to JSON.stringify. */
export const EMIT_KEY: unique symbol = Symbol.for("syncengine.emit");

/** Well-known Symbol key used to carry workflow triggers on the
 *  handler's return value. Non-enumerable, invisible to JSON.stringify. */
export const TRIGGER_KEY: unique symbol = Symbol.for("syncengine.trigger");

/** Well-known Symbol key used to carry emitted bus publishes on the
 *  handler's return value. Mirrors EMIT_KEY + TRIGGER_KEY. */
export const PUBLISH_KEY: unique symbol = Symbol.for("syncengine.publish");

/** A workflow trigger attached to a handler's return value via TRIGGER_KEY. */
export interface EmitTrigger {
    readonly workflow: string;
    readonly input: unknown;
}

/** A table row to publish as an INSERT delta (runtime representation —
 *  always carries the table name as a string). */
export interface EmitInsert {
  readonly table: string;
  readonly record: Record<string, unknown>;
}

/** Helper: for each field in a table's record, make it optional and
 *  widen string columns to accept any `string` (including the `'$key'`
 *  placeholder the entity runtime resolves at publish time). Enum
 *  strictness is intentionally relaxed — handler params are typically
 *  plain `string`, and the real value of this type is catching wrong
 *  field names and kind mismatches (string vs number). */
type EmitRecord<TCols extends Record<string, ColumnDef<unknown>>> = {
  [K in keyof InferRecord<TCols>]?:
    InferRecord<TCols>[K] extends string
      ? string
      : InferRecord<TCols>[K];
};

/** A typed emit insert — validates the record shape against the target
 *  table's columns at compile time. */
export interface TypedEmitInsert<T extends AnyTable> {
  readonly table: T;
  readonly record: EmitRecord<T['$columns']>;
}

/** @deprecated Use table references instead of string table names.
 *  Will be removed in a future major version. */
export interface LegacyEmitInsert {
  readonly table: string;
  readonly record: Record<string, unknown>;
}

/** Normalize a typed or legacy emit insert to the runtime form. */
function normalizeInsert(insert: TypedEmitInsert<AnyTable> | LegacyEmitInsert): EmitInsert {
  if (typeof insert.table === 'string') {
    return insert as EmitInsert;
  }
  return {
    table: (insert.table as AnyTable).$name,
    record: insert.record as Record<string, unknown>,
  };
}

/** Create a typed insert effect for use in `emit({ state, effects })`. */
export function insert<T extends AnyTable>(
    tableRef: T,
    record: EmitRecord<T['$columns']>,
): { readonly $effect: 'insert'; readonly table: T; readonly record: EmitRecord<T['$columns']> } {
    return { $effect: 'insert', table: tableRef, record };
}

/** Test-only — resets the deprecation-warning latch so successive
 *  runs in the same vitest process can each observe the first warn. */
let triggerDeprecationWarned = false;
export function __resetTriggerDeprecation(): void {
    triggerDeprecationWarned = false;
}

/**
 * @deprecated Use `publish(bus, event)` instead. `trigger()` is a tight
 * 1:1 coupling from an entity to a single named workflow; `publish()`
 * + a `defineWorkflow({ on: on(bus) })` subscriber decouple the emitter
 * from its consumers and unlock fan-out, DLQ, replay, and compensating
 * sagas. See `docs/migrations/2026-04-20-trigger-to-publish.md`.
 */
export function trigger<TInput>(
    workflow: { readonly $tag: 'workflow'; readonly $name: string },
    input: TInput,
): { readonly $effect: 'trigger'; readonly workflow: { readonly $tag: 'workflow'; readonly $name: string }; readonly input: TInput } {
    if (!triggerDeprecationWarned) {
        triggerDeprecationWarned = true;
        console.warn(
            `[syncengine] trigger() is deprecated and will be removed in a future release. ` +
            `Migrate to bus + publish(). See docs/migrations/2026-04-20-trigger-to-publish.md.`,
        );
    }
    return { $effect: 'trigger', workflow, input };
}

/** An emitted bus publish attached to a handler's return value via PUBLISH_KEY. */
export interface EmitPublish<T = unknown> {
    readonly $effect: 'publish';
    /** Minimal shape — dodges the cross-import to @syncengine/core's bus.ts
     *  to avoid circular type references. Runtime shape is the full BusRef. */
    readonly bus: {
        readonly $tag: 'bus';
        readonly $name: string;
        readonly $schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: Error } };
    };
    readonly payload: T;
}

/** Create a typed publish effect for use in `emit({ state, effects })`.
 *  Payload is validated against the bus schema at call time. */
export function publish<T>(
    bus: EmitPublish<T>['bus'],
    payload: T,
): EmitPublish<T> {
    const parsed = bus.$schema.safeParse(payload);
    if (!parsed.success) {
        throw new Error(
            `publish(${bus.$name}): invalid bus payload — ${parsed.error.message}`,
        );
    }
    return { $effect: 'publish', bus, payload: parsed.data };
}

/**
 * Wrap a handler's return state with table inserts that the entity
 * runtime will publish to the sync pipeline. The returned object IS
 * the new state — it just has a hidden Symbol property the framework
 * reads.
 *
 * All inserts in a single `emit()` call must target the same table
 * (the `T` generic is shared across the rest parameter). For
 * multi-table emits, use separate `emit()` calls or the legacy
 * string-based form.
 *
 * ```ts
 * handlers: {
 *   transfer: (state, toId, amount) => emit(
 *     { ...state, balance: state.balance - amount },
 *     { table: transactions, record: { to: toId, amount } },
 *   ),
 * }
 * ```
 */
/** New form: `emit({ state, effects })` — carries both inserts and triggers. */
export function emit<S extends Record<string, unknown>>(
  opts: { state: S; effects: ReadonlyArray<{ readonly $effect: string; [key: string]: unknown }> },
): S;
/** Legacy form: `emit(state, ...inserts)` — typed table references. */
export function emit<S extends Record<string, unknown>, T extends AnyTable>(
  state: S,
  ...inserts: TypedEmitInsert<T>[]
): S;
/** @deprecated Use table references instead of string table names. */
export function emit<S extends Record<string, unknown>>(
  state: S,
  ...inserts: LegacyEmitInsert[]
): S;
export function emit<S extends Record<string, unknown>>(
  stateOrOpts: S | { state: S; effects: ReadonlyArray<{ readonly $effect: string; [key: string]: unknown }> },
  ...inserts: (TypedEmitInsert<AnyTable> | LegacyEmitInsert)[]
): S {
  // Detect new { state, effects } form
  if (
    typeof stateOrOpts === 'object' &&
    stateOrOpts !== null &&
    'state' in stateOrOpts &&
    'effects' in stateOrOpts &&
    Array.isArray((stateOrOpts as { effects: unknown }).effects)
  ) {
    const { state, effects } = stateOrOpts as { state: S; effects: ReadonlyArray<{ readonly $effect: string; [key: string]: unknown }> };
    const wrapped = { ...state };

    // Separate effects into inserts, triggers, and publishes
    const insertEffects: EmitInsert[] = [];
    const triggerEffects: EmitTrigger[] = [];
    const publishEffects: EmitPublish[] = [];

    for (const effect of effects) {
      if (effect.$effect === 'insert') {
        const typed = effect as unknown as { table: AnyTable; record: Record<string, unknown> };
        insertEffects.push(normalizeInsert(typed));
      } else if (effect.$effect === 'trigger') {
        const typed = effect as unknown as { workflow: { $name: string }; input: unknown };
        triggerEffects.push({ workflow: typed.workflow.$name, input: typed.input });
      } else if (effect.$effect === 'publish') {
        publishEffects.push(effect as unknown as EmitPublish);
      }
    }

    if (insertEffects.length > 0) {
      Object.defineProperty(wrapped, EMIT_KEY, {
        value: insertEffects,
        enumerable: false,
        configurable: true,
      });
    }

    if (triggerEffects.length > 0) {
      Object.defineProperty(wrapped, TRIGGER_KEY, {
        value: triggerEffects,
        enumerable: false,
        configurable: true,
      });
    }

    if (publishEffects.length > 0) {
      Object.defineProperty(wrapped, PUBLISH_KEY, {
        value: publishEffects,
        enumerable: false,
        configurable: true,
      });
    }

    return wrapped as S;
  }

  // Legacy form: emit(state, ...inserts)
  const wrapped = { ...(stateOrOpts as S) };
  const normalized = inserts.map(normalizeInsert);
  // Non-enumerable: the symbol must NOT survive `{ ...base, ...result }`
  // spreading in `applyHandler`, otherwise stale emits bleed through to
  // the next action during client-side `rebase`. `applyHandler` extracts
  // emits from the raw handler result BEFORE the spread and re-attaches
  // them to the validated output. JSON.stringify ignores all Symbols.
  Object.defineProperty(wrapped, EMIT_KEY, {
    value: normalized,
    enumerable: false,
    configurable: true,
  });
  return wrapped as S;
}

/** Extract emitted inserts from a handler return value, if any. */
export function extractEmits(
  state: Record<string, unknown>,
): EmitInsert[] | undefined {
  return (state as Record<symbol, unknown>)[EMIT_KEY] as
    | EmitInsert[]
    | undefined;
}

/** Extract workflow triggers from a handler return value, if any. */
export function extractTriggers(
  state: Record<string, unknown>,
): EmitTrigger[] | undefined {
  return (state as Record<symbol, unknown>)[TRIGGER_KEY] as
    | EmitTrigger[]
    | undefined;
}

/** Extract bus publishes from a handler return value, if any. Mirrors
 *  `extractEmits` / `extractTriggers` — keeps the three effect types
 *  as parallel extractors rather than a single multi-shape function,
 *  matching the existing pattern the server + vite-plugin runtimes
 *  already consume. */
export function extractPublishes(
  state: Record<string, unknown>,
): EmitPublish[] | undefined {
  return (state as Record<symbol, unknown>)[PUBLISH_KEY] as
    | EmitPublish[]
    | undefined;
}

// ── Source projections — derived entity state from tables ────────────────────
//
// `source` declarations on `defineEntity` let an entity track simple
// aggregates (sum, count, min, max) over table rows linked by a key
// column. The projections are stored in Restate state alongside the
// user-defined state and updated incrementally every time the handler
// calls `emit()`. The handler sees a unified state object with both
// user fields and projection fields.

/** Wire representation of a single source projection. */
export interface SourceProjectionDef {
  readonly table: string;
  readonly fn: "sum" | "count" | "min" | "max";
  readonly field: string; // column to aggregate ('*' for count)
  readonly keyColumn: string; // column in table that matches entity key
}

/** Map of projection name → definition. */
export type SourceProjections = Record<string, SourceProjectionDef>;

function refOrStr(x: string | ColumnRef<string, string, unknown>): string {
  return typeof x === "string" ? x : x.$name;
}

/** Declare a `sum(column)` projection scoped by a key column. */
export function sourceSum(
  table: AnyTable,
  valueCol: string | ColumnRef<string, string, number>,
  keyCol: string | ColumnRef<string, string, unknown>,
): SourceProjectionDef {
  return {
    table: table.$name,
    fn: "sum",
    field: refOrStr(valueCol),
    keyColumn: refOrStr(keyCol),
  };
}

/** Declare a `count(*)` projection scoped by a key column. */
export function sourceCount(
  table: AnyTable,
  keyCol: string | ColumnRef<string, string, unknown>,
): SourceProjectionDef {
  return {
    table: table.$name,
    fn: "count",
    field: "*",
    keyColumn: refOrStr(keyCol),
  };
}

/** Declare a `min(column)` projection scoped by a key column. */
export function sourceMin(
  table: AnyTable,
  valueCol: string | ColumnRef<string, string, number>,
  keyCol: string | ColumnRef<string, string, unknown>,
): SourceProjectionDef {
  return {
    table: table.$name,
    fn: "min",
    field: refOrStr(valueCol),
    keyColumn: refOrStr(keyCol),
  };
}

/** Declare a `max(column)` projection scoped by a key column. */
export function sourceMax(
  table: AnyTable,
  valueCol: string | ColumnRef<string, string, number>,
  keyCol: string | ColumnRef<string, string, unknown>,
): SourceProjectionDef {
  return {
    table: table.$name,
    fn: "max",
    field: refOrStr(valueCol),
    keyColumn: refOrStr(keyCol),
  };
}

/** Compute initial projection values from the aggregate function. */
export function buildSourceInitial(
  source: SourceProjections,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, def] of Object.entries(source)) {
    switch (def.fn) {
      case "sum":
      case "count":
        out[name] = 0;
        break;
      case "min":
        out[name] = Number.POSITIVE_INFINITY;
        break;
      case "max":
        out[name] = Number.NEGATIVE_INFINITY;
        break;
    }
  }
  return out;
}

// ── Projection merge / split / apply ────────────────────────────────────────

/** Merge user state and source projections into the unified object
 *  the handler receives. */
export function mergeSourceIntoState(
  userState: Record<string, unknown>,
  projections: Record<string, number>,
): Record<string, unknown> {
  return { ...userState, ...projections };
}

/** Extract only user-defined fields from the handler's return value,
 *  discarding any source projection fields the handler may have
 *  returned unchanged. */
export function pickUserState(
  result: Record<string, unknown>,
  stateShape: EntityStateShape,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(stateShape)) {
    if (key in result) out[key] = result[key];
  }
  return out;
}

/**
 * Incrementally update source projections based on emitted table
 * inserts. Each emit is checked against the projection's table and
 * key column. If the emit's `record[keyColumn]` matches `entityKey`,
 * the aggregate is updated.
 *
 * The `entityKey` parameter is the raw entity instance key (e.g.,
 * `'alice'`). Emit records that use the literal `'$key'` as the key
 * value are also matched (the entity runtime resolves `'$key'` to
 * the actual key before publishing, but at the projection-update
 * stage we check both).
 */
export function applySourceDeltas(
  current: Record<string, number>,
  sourceDefs: SourceProjections,
  emits: EmitInsert[] | undefined,
  entityKey: string,
): Record<string, number> {
  if (!emits || emits.length === 0) return current;

  const updated = { ...current };
  for (const [projName, def] of Object.entries(sourceDefs)) {
    for (const insert of emits) {
      if (insert.table !== def.table) continue;
      const recordKeyValue = insert.record[def.keyColumn];
      if (recordKeyValue !== entityKey && recordKeyValue !== "$key") continue;

      const val = def.field === "*" ? 1 : Number(insert.record[def.field]) || 0;
      switch (def.fn) {
        case "sum":
          updated[projName] = (updated[projName] ?? 0) + val;
          break;
        case "count":
          // Every emit is a new row insertion → always +1. A compensating
          // emit (negative amount) is still a new transaction/event.
          updated[projName] = (updated[projName] ?? 0) + 1;
          break;
        case "min":
          updated[projName] = Math.min(
            updated[projName] ?? Number.POSITIVE_INFINITY,
            val,
          );
          break;
        case "max":
          updated[projName] = Math.max(
            updated[projName] ?? Number.NEGATIVE_INFINITY,
            val,
          );
          break;
      }
    }
  }
  return updated;
}

// ── Pure handler execution ─────────────────────────────────────────────────
//
// `applyHandler` runs one handler on a current state, validates the result,
// and returns the new state. It is PURE — no Restate context, no NATS, no
// I/O — which is what lets the framework reuse the exact same code on both
// the server (wrapped with ctx.get/set/publish by the entity-runtime) and
// the client (as the engine behind `useEntity`'s latency compensation, so
// the optimistic UI result matches whatever the server will compute).
//
// Throws a plain Error on unknown handler, user-thrown rejection, or state
// validation failure. The caller is responsible for translating the error
// to its transport's native error shape (TerminalError on the server,
// Promise rejection on the client).

/**
 * Apply one handler to a current state, validate the result, and return
 * the new state.
 *
 * `currentState === null` is treated as "no stored state yet" — the
 * entity's `$initialState` is used as the starting point. Handlers may
 * return either the full next state or a `Partial<State>` that gets
 * merged into the current record.
 */
export function applyHandler(
  entity: AnyEntity,
  handlerName: string,
  currentState: Record<string, unknown> | null,
  args: readonly unknown[],
): Record<string, unknown> {
  const handlerFn = entity.$handlers[handlerName] as
    | EntityHandler<Record<string, unknown>, readonly unknown[]>
    | undefined;
  if (!handlerFn) {
    throw errors.handler(HandlerCode.HANDLER_NOT_FOUND, {
      message: `entity '${entity.$name}': no handler named '${handlerName}'.`,
      hint: `Available handlers: ${Object.keys(entity.$handlers).join(', ')}`,
      context: { entity: entity.$name, handler: handlerName },
    });
  }

  const base =
    currentState ?? (entity.$initialState as Record<string, unknown>);

  let next: Record<string, unknown>;
  let emits: EmitInsert[] | undefined;
  let triggers: EmitTrigger[] | undefined;
  let rawResult: Record<string, unknown> | undefined;
  try {
    const result = handlerFn(base, ...args);
    rawResult = result as Record<string, unknown>;
    // Capture emit()ed inserts and triggers before the spread (they
    // survive the spread since EMIT_KEY/TRIGGER_KEY are non-enumerable,
    // but validateEntityState builds a fresh object that drops them).
    emits = extractEmits(rawResult);
    triggers = extractTriggers(rawResult);
    // Allow handlers to return a partial state — merge into the current
    // record. Returning the full state also works (the spread is a no-op).
    next = { ...base, ...result };
  } catch (err) {
    // Typed errors propagate unchanged so callers can pattern-match on them.
    //   - SyncEngineError: framework errors re-thrown through user code.
    //   - EntityError: user domain errors (Meteor-style, orthogonal to the
    //     platform error system — see docs/.../error-system.md).
    if (err instanceof SyncEngineError) throw err;
    if (err instanceof EntityError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw errors.handler(HandlerCode.USER_HANDLER_ERROR, {
      message: `entity '${entity.$name}' handler '${handlerName}' rejected: ${message}`,
      context: { entity: entity.$name, handler: handlerName },
      cause: err instanceof Error ? err : new Error(String(err)),
    });
  }

  // Validate declared state fields but preserve extra fields (e.g.,
  // source projection values like balance/txnCount). The handler may
  // return optimistic projection values for latency compensation —
  // stripping them would flash $0 until the server responds.
  const validated = validateEntityState(
    entity.$state,
    next,
    entity.$name,
  ) as Record<string, unknown>;

  // Merge back any fields from `next` that aren't in $state — these
  // are projection fields the handler computed optimistically.
  for (const k of Object.keys(next)) {
    if (!(k in entity.$state) && !(k in validated)) {
      validated[k] = next[k];
    }
  }

  // ── Transition guard ─────────────────────────────────────────────────
  // If the entity declares transitions and the handler's return value
  // includes the status field, verify the transition is allowed. Partial
  // returns that omit the status field skip the guard, so handlers that
  // mutate only non-status fields are unconstrained by the transition map.
  // Self-transitions (same value) are also checked — terminal states
  // reject all handler calls that touch the status field.
  if (entity.$transitions && entity.$statusField && rawResult) {
    const field = entity.$statusField;
    if (field in rawResult) {
      const oldStatus = base[field] as string;
      const newStatus = validated[field] as string;
      const allowed = entity.$transitions[oldStatus];
      if (!allowed || !(allowed as readonly string[]).includes(newStatus)) {
        throw errors.entity(EntityCode.INVALID_TRANSITION, {
          message: `Cannot transition '${field}' from '${oldStatus}' to '${newStatus}'.`,
          hint: `Valid transitions from '${oldStatus}': ${(allowed ?? []).join(', ')}.`,
          context: { entity: entity.$name, field, from: oldStatus, to: newStatus },
        });
      }
    }
  }

  // Re-attach emit()ed inserts to the validated state so the entity
  // runtime can extract them after applyHandler returns.
  if (emits) {
    Object.defineProperty(validated, EMIT_KEY, {
      value: emits,
      enumerable: false,
      configurable: true,
    });
  }

  // Re-attach workflow triggers to the validated state so the entity
  // runtime can extract them after applyHandler returns.
  if (triggers) {
    Object.defineProperty(validated, TRIGGER_KEY, {
      value: triggers,
      enumerable: false,
      configurable: true,
    });
  }

  return validated;
}

// ── Rebase (latency compensation) ──────────────────────────────────────────
//
// `rebase` takes a confirmed server state and a queue of pending local
// actions, and computes the optimistic state by folding each pending
// handler over the confirmed state in order. Used by the client's
// `useEntity` hook: whenever the confirmed state changes (initial read,
// NATS broadcast, or server response to our own action), we recompute
// the optimistic layer by re-running every still-pending action.
//
// If a pending handler throws mid-rebase (e.g., a remote mutation changed
// the state such that our local call is no longer valid), the handler is
// DROPPED from the output chain and its STABLE ID is recorded in
// `failedIds`. The caller is responsible for deciding what to do with
// failures — typically the useEntity hook waits for the in-flight
// server response to deliver the authoritative verdict, since the
// server might succeed or fail independently of our local check.
//
// Using stable ids rather than array indices makes the result
// immune to any mutation of the pending array between the rebase call
// and the caller's filter step (e.g., if another action resolves
// concurrently and the caller re-filters the queue).

export interface RebaseResult {
  /** The optimistic state after folding valid pending actions over
   *  the confirmed base. If `confirmed` is null, this is also null. */
  readonly state: Record<string, unknown> | null;
  /** Stable IDs of pending actions that threw during rebase. The
   *  caller typically drops these from the pending queue. */
  readonly failedIds: readonly number[];
}

export interface PendingActionLike {
  /** Stable, monotonically-increasing id assigned at enqueue time.
   *  Used by `rebase()` to report failures without relying on array
   *  indices that may shift if the pending queue is mutated
   *  concurrently. */
  readonly id: number;
  readonly handlerName: string;
  readonly args: readonly unknown[];
}

export function rebase(
  entity: AnyEntity,
  confirmed: Record<string, unknown> | null,
  pending: readonly PendingActionLike[],
): RebaseResult {
  if (confirmed === null) {
    return { state: null, failedIds: [] };
  }
  let state = confirmed;
  const failedIds: number[] = [];
  for (const action of pending) {
    try {
      state = applyHandler(entity, action.handlerName, state, action.args);
    } catch {
      // Rebase failed on this action — drop it from the chain but
      // keep folding subsequent actions on the unchanged state.
      failedIds.push(action.id);
    }
  }
  return { state, failedIds };
}

/** Generic alias used in function signatures that accept any entity, the
 *  same way `AnyTable` is used for tables. We use `any` for the handler-map
 *  and source parameters because the constraint binds multiple generics
 *  together — `unknown` is too narrow to satisfy it, and there's no other
 *  way to express "any handler map / source" without losing the binding.
 *  Function signatures that accept `AnyEntity` must not reach into handler
 *  argument types — those are erased at this layer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEntity = EntityDef<string, EntityStateShape, any, any>;

// ── Transition introspection ──────────────────────────────────────────────

/** Return the terminal states (states with no outgoing transitions).
 *  Returns an empty array if the entity has no transitions declared. */
export function getTerminalStates(entity: AnyEntity): readonly string[] {
  if (!entity.$transitions) return [];
  return Object.entries(entity.$transitions)
    .filter(([, targets]) => targets.length === 0)
    .map(([state]) => state);
}

/** Return the full transition graph for devtools / visualization.
 *  Returns null if the entity has no transitions declared. */
export function getTransitionGraph(entity: AnyEntity): {
  readonly field: string;
  readonly states: readonly string[];
  readonly transitions: TransitionMap;
  readonly terminal: readonly string[];
  readonly initial: string;
} | null {
  if (!entity.$transitions || !entity.$statusField) return null;
  const terminal = Object.entries(entity.$transitions)
    .filter(([, targets]) => targets.length === 0)
    .map(([state]) => state);
  return {
    field: entity.$statusField,
    states: Object.keys(entity.$transitions),
    transitions: entity.$transitions,
    terminal,
    initial: entity.$initialState[entity.$statusField] as string,
  };
}
