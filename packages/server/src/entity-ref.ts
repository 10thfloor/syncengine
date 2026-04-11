// ── entityRef — typed actor reference ────────────────────────────────────────
//
// `entityRef()` returns a Proxy that wraps Restate's `ctx.objectClient()`
// with types inferred from an EntityDef. Server-side code (other entity
// handlers or workflows) calls `entityRef(ctx, def, key).handlerName(...args)`
// to make a durable RPC to the target entity instance — fully typed, no
// string handler names, no manual arg serialization.
//
// The Proxy is lazy: `objectClient` is called once (on first property
// access or on construction — here we eagerly grab the client), and each
// handler access returns a thin wrapper that forwards the args array.

import type {
    EntityDef,
    EntityStateShape,
    EntityHandlerMap,
    EntityHandler,
} from '@syncengine/core';
import { splitObjectKey, ENTITY_OBJECT_PREFIX } from './entity-keys.js';

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
    ctx: { key: string; objectClient(opts: { name: string }, key: string): any },
    entityDef: EntityDef<TName, TShape, THandlers, TSourceKeys>,
    key: string,
): EntityRefProxy<THandlers> {
    const { workspaceId } = splitObjectKey(ctx.key);
    const fullKey = `${workspaceId}/${key}`;
    const client = ctx.objectClient(
        { name: `${ENTITY_OBJECT_PREFIX}${entityDef.$name}` },
        fullKey,
    );

    return new Proxy({} as EntityRefProxy<THandlers>, {
        get(_, handlerName: string) {
            return (...args: unknown[]) => client[handlerName](args);
        },
    });
}
