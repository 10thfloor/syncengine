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

import type { ColumnDef, InferRecord } from './schema';

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
    THandlers extends EntityHandlerMap<EntityState<TShape>>,
> {
    readonly $tag: 'entity';
    readonly $name: TName;
    readonly $state: TShape;
    readonly $handlers: THandlers;
    /** Initial state — every column's default applied. Used the first time
     *  an entity instance is read before any handler has run. */
    readonly $initialState: EntityState<TShape>;
    /** Phantom field carrying the inferred state record type for callers
     *  that want `EntityRecord<typeof cart>` without re-deriving it. */
    readonly $record: EntityState<TShape>;
}

/** Type-level shortcut: extract the state record type from an EntityDef. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EntityRecord<E> = E extends EntityDef<string, infer TShape, any>
    ? EntityState<TShape>
    : never;

/** Type-level shortcut: extract the handler map from an EntityDef. */
export type EntityHandlers<E> = E extends EntityDef<string, EntityStateShape, infer THandlers>
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
    entityName = '<entity>',
): EntityState<TShape> {
    const out: Record<string, unknown> = {};
    for (const [name, col] of Object.entries(shape)) {
        const value = record[name];
        if (value === undefined || value === null) {
            if (col.nullable) {
                out[name] = null;
                continue;
            }
            throw new Error(
                `Entity '${entityName}': column '${name}' is required but missing.`,
            );
        }
        const expectedType = jsTypeForKind(col.kind);
        if (expectedType && typeof value !== expectedType) {
            throw new Error(
                `Entity '${entityName}': column '${name}' expects ${expectedType}, ` +
                `got ${typeof value} (${JSON.stringify(value)}).`,
            );
        }
        if (col.enum && !col.enum.includes(value as never)) {
            throw new Error(
                `Entity '${entityName}': column '${name}' must be one of ` +
                `${JSON.stringify(col.enum)}, got ${JSON.stringify(value)}.`,
            );
        }
        out[name] = value;
    }
    return out as EntityState<TShape>;
}

function jsTypeForKind(kind: import('./schema').ColumnKind): 'string' | 'number' | 'boolean' | null {
    switch (kind) {
        case 'id':
        case 'integer':
        case 'real':
            return 'number';
        case 'text':
            return 'string';
        case 'boolean':
            return 'boolean';
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
function buildInitialState<TShape extends EntityStateShape>(
    shape: TShape,
): EntityState<TShape> {
    const out: Record<string, unknown> = {};
    for (const [name, col] of Object.entries(shape)) {
        if (col.nullable) {
            out[name] = null;
            continue;
        }
        const type = jsTypeForKind(col.kind);
        if (type === 'number') out[name] = 0;
        else if (type === 'string') out[name] = col.enum ? col.enum[0] : '';
        else if (type === 'boolean') out[name] = false;
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
export function defineEntity<
    const TName extends string,
    TShape extends EntityStateShape,
    THandlers extends EntityHandlerMap<EntityState<TShape>>,
>(
    name: TName,
    config: {
        readonly state: TShape;
        readonly handlers: THandlers;
    },
): EntityDef<TName, TShape, THandlers> {
    // Runtime guards: catch the easy mistakes at construction time so the
    // user sees them on import, not on first handler call.
    if (!name || typeof name !== 'string') {
        throw new Error(`defineEntity: name must be a non-empty string.`);
    }
    if (name.startsWith('$')) {
        throw new Error(
            `defineEntity('${name}'): names may not start with '$' ` +
            `(reserved for framework metadata).`,
        );
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(
            `defineEntity('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/ ` +
            `so it can be used as a Restate object name and a NATS subject token.`,
        );
    }
    for (const colName of Object.keys(config.state)) {
        if (colName.startsWith('$')) {
            throw new Error(
                `defineEntity('${name}'): state field '${colName}' may not start ` +
                `with '$' (reserved for framework metadata).`,
            );
        }
    }
    for (const [handlerName, fn] of Object.entries(config.handlers)) {
        if (typeof fn !== 'function') {
            throw new Error(
                `defineEntity('${name}'): handler '${handlerName}' must be a function.`,
            );
        }
        // Restate's handler-name regex is ^([a-zA-Z]|_[a-zA-Z0-9])[a-zA-Z0-9_]*$.
        // Names starting with `_` (single underscore + letter/digit) are
        // reserved for the framework's built-in handlers (`_read`, `_init`,
        // any future additions). `$` is reserved for metadata fields.
        if (handlerName.startsWith('_') || handlerName.startsWith('$')) {
            throw new Error(
                `defineEntity('${name}'): handler name '${handlerName}' is reserved ` +
                `(framework uses '_'/'$' prefixes for internal handlers).`,
            );
        }
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(handlerName)) {
            throw new Error(
                `defineEntity('${name}'): handler name '${handlerName}' must match ` +
                `/^[a-zA-Z][a-zA-Z0-9_]*$/ (Restate's handler-name regex).`,
            );
        }
    }

    return {
        $tag: 'entity',
        $name: name,
        $state: config.state,
        $handlers: config.handlers,
        $initialState: buildInitialState(config.state),
        $record: undefined as never,
    };
}

// ── Runtime helpers ────────────────────────────────────────────────────────

/** Type guard for any entity definition. */
export function isEntity(x: unknown): x is AnyEntity {
    return typeof x === 'object' && x !== null && (x as { $tag?: string }).$tag === 'entity';
}

/** Generic alias used in function signatures that accept any entity, the
 *  same way `AnyTable` is used for tables. We use `any` for the handler-map
 *  parameter because the constraint `EntityHandlerMap<EntityState<TShape>>`
 *  binds two generics together — `unknown` is too narrow to satisfy it,
 *  and there's no other way to express "any handler map" without losing
 *  the binding. Function signatures that accept `AnyEntity` must not
 *  reach into handler argument types — those are erased at this layer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEntity = EntityDef<string, EntityStateShape, any>;
