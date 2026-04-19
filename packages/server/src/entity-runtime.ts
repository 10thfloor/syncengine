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
    extractTriggers,
    extractPublishes,
    mergeSourceIntoState,
    pickUserState,
    applySourceDeltas,
    AccessDeniedError,
    EntityError,
    SyncEngineError,
    type AuthProvider,
    errors,
    SchemaCode,
    type AnyEntity,
    type EmitInsert,
    type EmitPublish,
    type EmitTrigger,
} from "@syncengine/core";
import { instrument } from '@syncengine/observe';
import { splitObjectKey, ENTITY_OBJECT_PREFIX } from './entity-keys.js';
import { WORKFLOW_OBJECT_PREFIX } from './workflow.js';
import { resolveAuth } from './auth/resolve-auth.js';


const STATE_KEY = "state";
const SOURCE_KEY = "source";

// Module-level auth provider — installed at startRestateEndpoint via
// setAuthProvider(). Undefined in pre-auth apps and in tests that don't
// wire a provider. runHandler reads this to verify the bearer token on
// every handler invocation.
let _authProvider: AuthProvider | undefined;

/** Install the auth provider used by all entity handler invocations.
 *  Called at startRestateEndpoint; `undefined` disables RPC-path auth. */
export function setAuthProvider(provider: AuthProvider | undefined): void {
    _authProvider = provider;
}

/** Result envelope returned by every entity handler. */
interface HandlerResult {
    state: Record<string, unknown>;
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

    // Plan 3: verify the Authorization header and enrich with workspace
    // membership role. Returns null for unauthenticated callers — only
    // Access.public handlers accept that; other policies reject it.
    const authHeader = ctx.request().headers.get('authorization') ?? undefined;
    const user = await resolveAuth({
        provider: _authProvider,
        authHeader,
        workspaceId,
        lookupRole: async (userId, wsId) => {
            // Call workspace.isMember on the workspace virtual object.
            // `ctx.objectClient` is the in-Restate RPC to another object.
            // Restate types are opaque here; the handler contract comes
            // from packages/server/src/workspace/workspace.ts:isMember.
            const wsClient = ctx.objectClient({ name: 'workspace' }, wsId) as unknown as {
                isMember(args: { userId: string }): Promise<{ isMember: boolean; role?: string }>;
            };
            const result = await wsClient.isMember({ userId });
            return result.role ?? null;
        },
    });

    let validated: Record<string, unknown>;
    try {
        validated = applyHandler(entity, handlerName, merged, args, {
            user,
            key: entityKey,
        });
    } catch (err) {
        // AccessDenied gets its own prefix so the client can distinguish
        // permission-denied from business-logic rejection on the rebase path.
        if (err instanceof AccessDeniedError) {
            throw new restate.TerminalError(`[${err.code}] ${err.message}`);
        }
        // Typed errors carry structured fields; encode them into the
        // TerminalError message so they survive the Restate wire boundary.
        // hint/context drop here — clients that need structure must parse
        // the message format. See docs/.../error-system.md.
        if (err instanceof EntityError) {
            throw new restate.TerminalError(`[${err.code}] ${err.message}`);
        }
        if (err instanceof SyncEngineError) {
            throw new restate.TerminalError(`[${err.category}::${err.code}] ${err.message}`);
        }
        // applyHandler wraps everything else as UserHandlerError (a
        // SyncEngineError), so this fallback is defensive only.
        const message = err instanceof Error ? err.message : String(err);
        throw new restate.TerminalError(message);
    }

    // Extract emitted table inserts (Symbol key, invisible to JSON) and
    // resolve '$key' / '$user' placeholders. Plan 3 will wire a real user
    // id here; for now the server stubs userId as null, so '$user' slots
    // left by the handler stay as the literal string in the published row.
    const rawEmits = extractEmits(validated);
    const rawTriggers = extractTriggers(validated);
    const rawPublishes = extractPublishes(validated);
    const emits = rawEmits
        ? resolveEmitPlaceholders(rawEmits, { entityKey, userId: user?.id ?? null })
        : undefined;

    // Split: persist user state fields only (not projection fields)
    const userState = hasSource ? pickUserState(validated, entity.$state) : validated;
    ctx.set(STATE_KEY, userState);

    // Update projections incrementally from emitted deltas
    let updatedProjections = projections;
    if (hasSource && emits && emits.length > 0) {
        updatedProjections = applySourceDeltas(projections, entity.$source, [...emits], entityKey);
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

    // Dispatch workflow triggers from emit() effects
    if (rawTriggers && rawTriggers.length > 0) {
        dispatchWorkflowTriggers(ctx, rawTriggers);
    }

    // Dispatch bus publishes from emit() effects. Each publish is its
    // own ctx.run so Restate journals the NATS publish result; replays
    // reuse the journaled outcome and don't double-publish.
    if (rawPublishes && rawPublishes.length > 0) {
        await publishBusEvents(ctx, workspaceId, rawPublishes);
    }

    return { state: broadcastState };
}

/**
 * Resolve `'$key'` and `'$user'` placeholders in emitted insert records.
 * `'$key'` always resolves to the entity instance key. `'$user'` resolves
 * to the authenticated user id when available, otherwise remains as the
 * literal string (Plan 3 wires the real user id).
 */
export function resolveEmitPlaceholders(
    inserts: readonly EmitInsert[],
    ctx: { readonly entityKey: string; readonly userId: string | null },
): readonly EmitInsert[] {
    return inserts.map((ins) => {
        const values = Object.values(ins.record);
        const hasKeyPh = values.some((v) => v === '$key');
        const hasUserPh = ctx.userId !== null && values.some((v) => v === '$user');
        if (!hasKeyPh && !hasUserPh) return ins;
        const resolved: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(ins.record)) {
            if (v === '$key') resolved[k] = ctx.entityKey;
            else if (v === '$user' && ctx.userId !== null) resolved[k] = ctx.userId;
            else resolved[k] = v;
        }
        return { table: ins.table, record: resolved };
    });
}

/** Publish every `publish(bus, payload)` effect to NATS JetStream. The
 *  subject shape matches the one gateway-core's BusDispatcher listens on
 *  (`ws.<wsId>.bus.<busName>`) so subscriber workflows wake up via their
 *  durable consumer.
 *
 *  Uses `js.publish()` (JetStream publish) instead of NATS core `nc.publish()`
 *  so we get a `PubAck` confirming the message was durably persisted to the
 *  stream. If the ack fails, `ctx.run` throws and Restate retries the handler. */
async function publishBusEvents(
    ctx: restate.ObjectContext,
    workspaceId: string,
    publishes: readonly EmitPublish[],
): Promise<void> {
    for (const pub of publishes) {
        const subject = `ws.${workspaceId}.bus.${pub.bus.$name}`;
        const body = JSON.stringify(pub.payload);
        await ctx.run(`bus:${pub.bus.$name}:publish`, async () => {
            const { getJetStream } = await import("./workspace/nats-client.js");
            const js = await getJetStream();
            await js.publish(subject, body);
        });
    }
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
        const { getNatsConnection } = await import("./workspace/nats-client.js");
        const nc = await getNatsConnection();
        nc.publish(subject, JSON.stringify({
            type: "ENTITY_STATE",
            entity: entityName,
            key: entityKey,
            state,
        }));
        await nc.flush();
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
        const { getJetStream } = await import("./workspace/nats-client.js");
        const js = await getJetStream();
        for (let i = 0; i < inserts.length; i++) {
            await js.publish(subject, JSON.stringify({
                type: "INSERT",
                table: inserts[i]!.table,
                record: inserts[i]!.record,
                _clientId: "restate-entity-runtime",
                _nonce: nonces[i],
            }));
        }
    });
}

/** Dispatch workflow invocations triggered by emit() effects.
 *  Each trigger creates a new workflow execution keyed by a unique id.
 *  Uses Restate's workflowSendClient for fire-and-forget dispatch —
 *  the workflow runs asynchronously after the entity handler returns. */
function dispatchWorkflowTriggers(
    ctx: restate.ObjectContext,
    triggers: readonly EmitTrigger[],
): void {
    for (const t of triggers) {
        const workflowName = `${WORKFLOW_OBJECT_PREFIX}${t.workflow}`;
        const workflowKey = `${ctx.key}-${ctx.rand.uuidv4()}`;
        const wfClient = ctx.workflowSendClient(
            { name: workflowName },
            workflowKey,
        ) as unknown as { run(input: unknown): void };
        wfClient.run(t.input);
    }
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
            const { workspaceId } = splitObjectKey(ctx.key);
            return instrument.entityEffect(
                { workspace: workspaceId, name: entity.$name, op: name },
                () => runHandler(ctx, entity, name, argList),
            );
        };
    }

    return bag;
}


/** Build the Restate object for one entity. Used by both `bindEntities`
 *  and tests that want to inspect the wrapped object directly. */
export function buildEntityObject(entity: AnyEntity): ReturnType<typeof restate.object> {
    if (!isEntity(entity)) {
        throw errors.schema(SchemaCode.NOT_ENTITY_DEFINITION, {
            message: `buildEntityObject: not an entity definition`,
            hint: `Pass a value created by defineEntity().`,
        });
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
