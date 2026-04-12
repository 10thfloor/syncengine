// ── Entity Runtime (Phase 4) ────────────────────────────────────────────────
//
// Wraps each user-defined `EntityDef` from `@syncengine/core` as a Restate
// virtual object so handler invocations get the same single-writer guarantee
// the workspace handler enjoys.
//
// Each entity TYPE becomes one Restate object whose name is `entity_{name}`
// (the prefix avoids any collision with the workspace object). Each entity
// INSTANCE is keyed by `{workspaceId}/{entityKey}` so workspaces are
// isolated and the existing per-key serialization model applies.
//
// Per-instance state is stored as a single JSON blob under the Restate
// state key `'state'`. Every handler runs the user's pure function on the
// current state, validates the result against the entity's column shape,
// persists it, and broadcasts the new state to NATS subject
// `ws.{workspaceId}.entity.{name}.{entityKey}.state`. All clients with a
// `useEntity(def, key)` subscription pick up the change.
//
// Two reserved handlers are added to every entity object:
//   - `_read`  : returns the current state (used by `useEntity` on first
//                mount before the NATS subscription delivers anything)
//   - `_init`  : seeds the initial state if no record exists yet (idempotent)
//
// The single underscore prefix is required by Restate's handler-name regex
// `^([a-zA-Z]|_[a-zA-Z0-9])[a-zA-Z0-9_]*$`, which rejects double-underscore
// names like `__read`. User handler names that collide with `_read`/`_init`
// are rejected at `defineEntity` construction time.

import * as restate from "@restatedev/restate-sdk";
import {
    isEntity,
    applyHandler,
    extractEmits,
    mergeSourceIntoState,
    pickUserState,
    applySourceDeltas,
    type AnyEntity,
    type EmitInsert,
} from "@syncengine/core";

const NATS_URL = process.env.NATS_URL || "nats://nats:4222";

const STATE_KEY = "state";
const SOURCE_KEY = "source";

/** Result envelope returned by every entity handler. */
interface HandlerResult {
    state: Record<string, unknown>;
}

/** Split a Restate virtual-object key of the form `{workspaceId}/{entityKey}`
 *  into its two components. The slash is the separator: workspace ids may
 *  not contain slashes (enforced upstream by the workspace provisioner). */
export function splitObjectKey(objKey: string): { workspaceId: string; entityKey: string } {
    const idx = objKey.indexOf("/");
    if (idx < 0) {
        throw new restate.TerminalError(
            `Entity key '${objKey}' must be of the form 'workspaceId/entityKey'.`,
        );
    }
    return {
        workspaceId: objKey.slice(0, idx),
        entityKey: objKey.slice(idx + 1),
    };
}

/** Run a user handler on the current state, persist the result, and
 *  broadcast it. Wraps `applyHandler` (the pure piece) with the Restate
 *  context I/O — load, save, publish. Errors from `applyHandler` are
 *  re-thrown as TerminalError so Restate returns a 4xx to the caller.
 *
 *  Source projections (Variation D): if the entity declares `source`,
 *  the handler sees a merged state containing both user fields and
 *  projection fields. After the handler, user state is split back,
 *  projections are updated incrementally from any `emit()` inserts,
 *  and both are persisted separately in Restate state. */
async function runHandler(
    ctx: restate.ObjectContext,
    entity: AnyEntity,
    handlerName: string,
    args: readonly unknown[],
): Promise<HandlerResult> {
    const { workspaceId, entityKey } = splitObjectKey(ctx.key);
    const hasSource = Object.keys(entity.$source).length > 0;

    // Load user state + source projections
    const stored = await ctx.get<Record<string, unknown>>(STATE_KEY);
    const projections = hasSource
        ? (await ctx.get<Record<string, number>>(SOURCE_KEY)) ?? { ...entity.$sourceInitial }
        : {};

    // Merge into the unified state the handler sees
    const base = stored ?? (entity.$initialState as Record<string, unknown>);
    const merged = hasSource ? mergeSourceIntoState(base, projections) : base;

    let validated: Record<string, unknown>;
    try {
        validated = applyHandler(entity, handlerName, merged, args);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as any)?.code;
        // Include code in the error message as a prefix so the client can parse it
        const fullMessage = code ? `[${code}] ${message}` : message;
        throw new restate.TerminalError(fullMessage);
    }

    // Extract emitted table inserts (Symbol key, invisible to JSON)
    // Resolve '$key' placeholders in record values to the actual entity key
    // so published rows have the real key in SQLite, not the literal '$key'.
    const rawEmits = extractEmits(validated);
    const emits = rawEmits?.map((ins) => {
        const hasPlaceholder = Object.values(ins.record).some((v) => v === '$key');
        if (!hasPlaceholder) return ins;
        const resolved: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(ins.record)) {
            resolved[k] = v === '$key' ? entityKey : v;
        }
        return { table: ins.table, record: resolved };
    });

    // Split: persist user state fields only (not projection fields)
    const userState = hasSource ? pickUserState(validated, entity.$state) : validated;
    ctx.set(STATE_KEY, userState);

    // Update projections incrementally from emitted deltas
    let updatedProjections = projections;
    if (hasSource && emits && emits.length > 0) {
        updatedProjections = applySourceDeltas(projections, entity.$source, emits, entityKey);
        ctx.set(SOURCE_KEY, updatedProjections);
    }

    // Broadcast the MERGED state so clients see both user + projection fields
    const broadcastState = hasSource
        ? mergeSourceIntoState(userState, updatedProjections)
        : userState;
    await publishState(ctx, workspaceId, entity.$name, entityKey, broadcastState);

    // Publish emitted table deltas to the entity-writes subject
    if (emits && emits.length > 0) {
        await publishTableDeltas(ctx, workspaceId, emits);
    }

    return { state: broadcastState };
}

/** Publish a state-update message via NATS core (ephemeral). The subject
 *  shape lets clients subscribe with a single wildcard:
 *  `ws.{workspaceId}.entity.>` to catch every entity update for a workspace. */
async function publishState(
    ctx: restate.ObjectContext,
    workspaceId: string,
    entityName: string,
    entityKey: string,
    state: Record<string, unknown>,
): Promise<void> {
    const subject = `ws.${workspaceId}.entity.${entityName}.${entityKey}.state`;
    await ctx.run("publish entity state", async () => {
        const { connect, JSONCodec } = await import("nats");
        const nc = await connect({ servers: NATS_URL });
        const codec = JSONCodec();
        nc.publish(subject, codec.encode({
            type: "ENTITY_STATE",
            entity: entityName,
            key: entityKey,
            state,
        }));
        await nc.flush();
        await nc.close();
    });
}

/** Publish emitted table rows to the `entity-writes` subject. The data
 *  worker subscribes to this subject alongside the channel subjects, so
 *  the rows flow through the same JetStream → DBSP pipeline as client
 *  inserts. Each insert gets its own message with a server-generated
 *  nonce so client-side dedup works correctly. */
async function publishTableDeltas(
    ctx: restate.ObjectContext,
    workspaceId: string,
    inserts: readonly EmitInsert[],
): Promise<void> {
    const subject = `ws.${workspaceId}.entity-writes`;
    // Generate deterministic nonces OUTSIDE ctx.run so Restate journal
    // replay produces identical values. ctx.rand is deterministic.
    const nonces = inserts.map(() => `restate-${ctx.key}-${ctx.rand.uuidv4()}`);
    await ctx.run("publish entity table deltas", async () => {
        const { connect, JSONCodec } = await import("nats");
        const nc = await connect({ servers: NATS_URL });
        const codec = JSONCodec();
        for (let i = 0; i < inserts.length; i++) {
            nc.publish(subject, codec.encode({
                type: "INSERT",
                table: inserts[i]!.table,
                record: inserts[i]!.record,
                _clientId: "restate-entity-runtime",
                _nonce: nonces[i],
            }));
        }
        await nc.flush();
        await nc.close();
    });
}

/** Build the Restate handler bag for one entity. Each user handler becomes
 *  one wrapped handler; we also inject `_read` and `_init`. */
function buildHandlerBag(entity: AnyEntity): Record<
    string,
    (ctx: restate.ObjectContext, args: unknown) => Promise<HandlerResult>
> {
    const bag: Record<
        string,
        (ctx: restate.ObjectContext, args: unknown) => Promise<HandlerResult>
    > = {};

    const hasSource = Object.keys(entity.$source).length > 0;

    // Built-in: _read — returns current state without mutating.
    // Merges source projections if the entity declares them.
    bag._read = async (ctx: restate.ObjectContext): Promise<HandlerResult> => {
        const stored = await ctx.get<Record<string, unknown>>(STATE_KEY);
        const state = stored ?? (entity.$initialState as Record<string, unknown>);
        if (!hasSource) return { state };
        const projections = (await ctx.get<Record<string, number>>(SOURCE_KEY)) ?? { ...entity.$sourceInitial };
        return { state: mergeSourceIntoState(state, projections) };
    };

    // Built-in: _init — idempotent seed of the initial state. Useful for
    // pre-creating entities before any handler call (rare). Returns the
    // existing state if already initialized; also initializes source
    // projections if not yet present.
    bag._init = async (ctx: restate.ObjectContext): Promise<HandlerResult> => {
        const stored = await ctx.get<Record<string, unknown>>(STATE_KEY);
        if (stored) {
            if (!hasSource) return { state: stored };
            const projections = (await ctx.get<Record<string, number>>(SOURCE_KEY)) ?? { ...entity.$sourceInitial };
            return { state: mergeSourceIntoState(stored, projections) };
        }
        const initial = entity.$initialState as Record<string, unknown>;
        ctx.set(STATE_KEY, initial);
        if (hasSource) {
            ctx.set(SOURCE_KEY, { ...entity.$sourceInitial });
            return { state: mergeSourceIntoState(initial, entity.$sourceInitial) };
        }
        return { state: initial };
    };

    for (const name of Object.keys(entity.$handlers)) {
        // Capture per-handler so the closure binds to the right function.
        bag[name] = (ctx: restate.ObjectContext, args: unknown): Promise<HandlerResult> => {
            // Wire format: handler args arrive as a single positional value
            // that is either:
            //   - undefined / null (no args)
            //   - an array of positional args
            //   - a single value (treated as one arg)
            // useEntity always sends the array form, but we accept the loose
            // shapes too so manual curl calls during dev work.
            const argList: readonly unknown[] = Array.isArray(args)
                ? args
                : args === undefined || args === null
                    ? []
                    : [args];
            return runHandler(ctx, entity, name, argList);
        };
    }

    return bag;
}

/** Prefix applied to every entity's Restate virtual-object name.
 *  Exported so other modules (e.g. entityRef) can build the canonical
 *  object name without duplicating the string literal. */
export const ENTITY_OBJECT_PREFIX = 'entity_';

/** Build the Restate object for one entity. Used by both `bindEntities`
 *  and tests that want to inspect the wrapped object directly. */
export function buildEntityObject(entity: AnyEntity): ReturnType<typeof restate.object> {
    if (!isEntity(entity)) {
        throw new Error(`buildEntityObject: not an entity definition`);
    }
    return restate.object({
        name: `${ENTITY_OBJECT_PREFIX}${entity.$name}`,
        handlers: buildHandlerBag(entity),
    });
}

/** Bind every entity in `entities` onto the given Restate endpoint builder.
 *  Returns the endpoint so callers can chain `.listen(port)` after. */
export function bindEntities<T>(
    endpoint: { bind(obj: ReturnType<typeof restate.object>): T },
    entities: readonly AnyEntity[],
): T {
    let chain: T = endpoint as unknown as T;
    for (const entity of entities) {
        const obj = buildEntityObject(entity);
        chain = (chain as unknown as {
            bind(obj: ReturnType<typeof restate.object>): T;
        }).bind(obj);
    }
    return chain;
}
