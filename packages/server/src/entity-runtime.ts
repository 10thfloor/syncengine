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
    type AnyEntity,
} from "@syncengine/core";

const NATS_URL = process.env.NATS_URL || "nats://nats:4222";

const STATE_KEY = "state";

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
 *  re-thrown as TerminalError so Restate returns a 4xx to the caller. */
async function runHandler(
    ctx: restate.ObjectContext,
    entity: AnyEntity,
    handlerName: string,
    args: readonly unknown[],
): Promise<HandlerResult> {
    const { workspaceId, entityKey } = splitObjectKey(ctx.key);

    const stored = await ctx.get<Record<string, unknown>>(STATE_KEY);

    let validated: Record<string, unknown>;
    try {
        validated = applyHandler(entity, handlerName, stored, args);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new restate.TerminalError(message);
    }

    // Persist atomically (Restate's `ctx.set` is part of the same journal
    // record as the handler return; either both happen or neither does).
    ctx.set(STATE_KEY, validated);

    // Fan out via NATS so subscribed clients update without polling.
    await publishState(ctx, workspaceId, entity.$name, entityKey, validated);

    return { state: validated };
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

    // Built-in: _read — returns current state without mutating.
    bag._read = async (ctx: restate.ObjectContext): Promise<HandlerResult> => {
        const stored = await ctx.get<Record<string, unknown>>(STATE_KEY);
        const state = stored ?? (entity.$initialState as Record<string, unknown>);
        return { state };
    };

    // Built-in: _init — idempotent seed of the initial state. Useful for
    // pre-creating entities before any handler call (rare). Returns the
    // existing state if already initialized.
    bag._init = async (ctx: restate.ObjectContext): Promise<HandlerResult> => {
        const stored = await ctx.get<Record<string, unknown>>(STATE_KEY);
        if (stored) return { state: stored };
        const initial = entity.$initialState as Record<string, unknown>;
        ctx.set(STATE_KEY, initial);
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

/** Build the Restate object for one entity. Used by both `bindEntities`
 *  and tests that want to inspect the wrapped object directly. */
export function buildEntityObject(entity: AnyEntity): ReturnType<typeof restate.object> {
    if (!isEntity(entity)) {
        throw new Error(`buildEntityObject: not an entity definition`);
    }
    return restate.object({
        name: `entity_${entity.$name}`,
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
