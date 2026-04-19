// ── entityRef — typed actor reference ────────────────────────────────────────
//
// `entityRef()` returns a Proxy that wraps Restate's `ctx.objectClient()`
// with types inferred from an EntityDef. Server-side code (other entity
// handlers or workflows) calls `entityRef(ctx, def, key).handlerName(...args)`
// to make a durable RPC to the target entity instance — fully typed, no
// string handler names, no manual arg serialization.
//
// Auth (Gap 2): call `entityRef(ctx, def, key, { asSystem: true })` (or
// its sibling `systemRef(ctx, def, key)`) to mark the invocation as
// framework-internal. The entity runtime sees the `x-syncengine-system`
// header, sets the handler auth context to `{ id: '$system' }`, and
// skips access policy enforcement. Used by workflows that need to
// advance entity state in response to bus events (e.g. `shipOnPay`
// calling `order.markShipped()`).

import type {
    EntityDef,
    EntityStateShape,
    EntityHandlerMap,
    EntityHandler,
} from '@syncengine/core';
import { splitObjectKey, ENTITY_OBJECT_PREFIX } from './entity-keys.js';

/** HTTP-style header recognized by the entity runtime to mark an
 *  invocation as `$system`-privileged. Set by `entityRef({ asSystem })`
 *  via Restate's `genericCall`. Never user-settable — the runtime only
 *  honors it on internal objectClient paths. */
export const SYSTEM_CALL_HEADER = 'x-syncengine-system';

// ── Public types ────────────────────────────────────────────────────────────

/**
 * The typed proxy surface exposed to callers. Each handler on the entity
 * becomes a method that accepts the handler's *caller* args (everything
 * after `state`) and returns `Promise<void>`.
 *
 * Example: if the entity has `add(state, amount: number)`, the ref
 * exposes `ref.add(amount: number): Promise<void>`.
 */
export type EntityRefProxy<THandlers> = {
    readonly [K in keyof THandlers]: THandlers[K] extends EntityHandler<any, infer TArgs>
        ? (...args: TArgs) => Promise<void>
        : never;
};

// ── Implementation ──────────────────────────────────────────────────────────

/**
 * Create a typed reference to a remote entity instance.
 *
 * @param ctx   - The Restate handler context (must have `.key` and
 *                `.objectClient`). The workspace ID is extracted from
 *                `ctx.key` so the caller doesn't need to thread it.
 * @param entityDef - The entity definition (e.g., `counter`). Drives
 *                    both the Restate object name and the TypeScript
 *                    handler signature inference.
 * @param key   - The entity instance key (without the workspace prefix).
 */
export function entityRef<
    TName extends string,
    TShape extends EntityStateShape,
    THandlers extends EntityHandlerMap<any>,
    TSourceKeys extends string,
>(
    ctx: {
        key: string;
        objectClient(opts: { name: string }, key: string): any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        genericCall?(call: any): Promise<any>;
    },
    entityDef: EntityDef<TName, TShape, THandlers, TSourceKeys>,
    key: string,
    opts?: { asSystem?: boolean },
): EntityRefProxy<THandlers> {
    const { workspaceId } = splitObjectKey(ctx.key);
    const fullKey = `${workspaceId}/${key}`;
    const service = `${ENTITY_OBJECT_PREFIX}${entityDef.$name}`;

    // Pick the invocation strategy once, then share the Proxy machinery.
    // - asSystem: Restate's genericCall so we can attach SYSTEM_CALL_HEADER.
    //   The entity runtime reads the header and sets auth.user = $system
    //   before the handler runs, bypassing access policies.
    // - default: the typed objectClient — the callee sees whatever auth
    //   header the outer invocation carried (often none for workflow
    //   chains, so its access policies see user=null).
    const invoke = opts?.asSystem
        ? buildSystemInvoker(ctx, service, fullKey)
        : buildDefaultInvoker(ctx, service, fullKey);

    return new Proxy({} as EntityRefProxy<THandlers>, {
        get(_, handlerName: string) {
            return (...args: unknown[]) => invoke(handlerName, args);
        },
    });
}

type Invoker = (handlerName: string, args: unknown[]) => Promise<unknown>;

function buildSystemInvoker(
    ctx: { genericCall?(call: unknown): Promise<unknown> },
    service: string,
    fullKey: string,
): Invoker {
    if (!ctx.genericCall) {
        throw new Error(
            'entityRef({ asSystem: true }) requires a context that exposes genericCall — ' +
            'only available inside Restate handlers.',
        );
    }
    const genericCall = ctx.genericCall;
    return (handlerName, args) =>
        genericCall({
            service,
            method: handlerName,
            key: fullKey,
            parameter: args,
            headers: { [SYSTEM_CALL_HEADER]: '1' },
        });
}

function buildDefaultInvoker(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: { objectClient(opts: { name: string }, key: string): any },
    service: string,
    fullKey: string,
): Invoker {
    const client = ctx.objectClient({ name: service }, fullKey);
    return (handlerName, args) => client[handlerName](args);
}

/**
 * Shorthand for `entityRef(ctx, def, key, { asSystem: true })`. Use in
 * workflows and framework-internal code that needs to advance entity
 * state without being rejected by the target entity's access policies.
 *
 *     const shipOnPay = defineWorkflow('shipOnPay', { on: ... },
 *         async (ctx, event) => {
 *             await systemRef(ctx, order, event.orderId).markShipped();
 *         });
 */
export function systemRef<
    TName extends string,
    TShape extends EntityStateShape,
    THandlers extends EntityHandlerMap<any>,
    TSourceKeys extends string,
>(
    ctx: Parameters<typeof entityRef<TName, TShape, THandlers, TSourceKeys>>[0],
    entityDef: EntityDef<TName, TShape, THandlers, TSourceKeys>,
    key: string,
): EntityRefProxy<THandlers> {
    return entityRef(ctx, entityDef, key, { asSystem: true });
}
