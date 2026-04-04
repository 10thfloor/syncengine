/// <reference path="./runtime-config.d.ts" />

// ── Entity Client (Phase 4) ─────────────────────────────────────────────────
//
// `useEntity(def, key)` is the React surface for an entity instance. It:
//
//   1. POSTs to Restate's `_read` handler on first mount to fetch the
//      current state of the entity, seeded from `def.$initialState` if
//      Restate has no record yet.
//   2. Subscribes to the per-instance NATS subject
//      `ws.{workspaceId}.entity.{name}.{key}.state` for live updates
//      published whenever any client invokes a handler.
//   3. Exposes `actions.{handlerName}(...args)` proxies that POST to
//      Restate, returning a promise that resolves with the new state.
//   4. Shares one subscription per `(entityType, entityKey)` across every
//      hook in the same tab. The first `useEntity(cart, 'k')` opens the
//      Restate read + NATS subscription; subsequent mounts on the same
//      key reuse the cached state and the live subscription. Last hook
//      to unmount tears them down.
//
// Single NATS WS connection per tab, opened lazily on the first useEntity
// call. The connection lives for the tab lifetime — there's no reconnect
// strategy yet (Phase 4b polish). On a connection drop, in-flight handler
// promises still resolve via the HTTP response, but state updates from
// other clients won't reach this tab until the page is reloaded.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type {
    AnyEntity,
    EntityDef,
    EntityState,
    EntityStateShape,
    EntityHandlerMap,
    EntityHandler,
} from '@syncengine/core';
import {
    workspaceId as runtimeWorkspaceId,
    natsUrl as runtimeNatsUrl,
    restateUrl as runtimeRestateUrl,
    authToken as runtimeAuthToken,
    // eslint-disable-next-line import/no-unresolved
} from 'virtual:syncengine/runtime-config';

// ── Public types ────────────────────────────────────────────────────────────

/** What `useEntity(def, key)` returns. */
export interface UseEntityResult<TState, THandlers> {
    /** Current entity state. `null` until the first read completes. */
    readonly state: TState | null;
    /** Per-handler invocation proxies. Each method posts to Restate and
     *  resolves with the new state (or rejects on handler failure). */
    readonly actions: ActionMap<TState, THandlers>;
    /** True after the initial read has completed. */
    readonly ready: boolean;
    /** Last handler error, if any. Cleared on the next successful call. */
    readonly error: Error | null;
}

/**
 * Map an entity's handler signatures into `(...args) => Promise<state>`
 * proxies. The first parameter of each user handler is the state and is
 * supplied by the framework — call sites only pass the trailing args.
 */
export type ActionMap<TState, THandlers> = {
    readonly [K in keyof THandlers]: THandlers[K] extends EntityHandler<TState, infer TArgs>
        ? (...args: TArgs) => Promise<TState>
        : never;
};

// ── Subscription registry (one per (entityName, entityKey)) ────────────────

interface EntitySubscription {
    state: Record<string, unknown> | null;
    error: Error | null;
    ready: boolean;
    listeners: Set<() => void>;
    /** Disposal: close the NATS subscription and forget the entry. */
    dispose: () => void;
}

const subscriptions = new Map<string, EntitySubscription>();

/** A lazy NATS connection shared across all entity subscriptions. */
let natsConnPromise: Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nc: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    codec: any;
}> | null = null;

async function getNats() {
    if (!natsConnPromise) {
        natsConnPromise = (async () => {
            const { connect, JSONCodec } = await import('nats.ws');
            const nc = await connect({ servers: runtimeNatsUrl });
            const codec = JSONCodec();
            return { nc, codec };
        })();
    }
    return natsConnPromise;
}

/** Open or reuse a subscription for a specific (entity, key). */
function getOrCreateSubscription(
    entity: AnyEntity,
    key: string,
): EntitySubscription {
    const subKey = `${entity.$name}/${key}`;
    const existing = subscriptions.get(subKey);
    if (existing) return existing;

    const sub: EntitySubscription = {
        state: null,
        error: null,
        ready: false,
        listeners: new Set(),
        dispose: () => {},
    };
    subscriptions.set(subKey, sub);

    // 1. Initial read via Restate POST `_read`. The result seeds the
    //    cache so the first render after mount has data without waiting
    //    for any NATS traffic.
    void invokeHandler(entity, key, '_read', [])
        .then((state) => {
            sub.state = state;
            sub.ready = true;
            notify(sub);
        })
        .catch((err: unknown) => {
            sub.error = err instanceof Error ? err : new Error(String(err));
            sub.ready = true;
            notify(sub);
        });

    // 2. Subscribe to the per-instance NATS subject for live updates.
    //    We close over `subscription` so the message handler always
    //    notifies the same listener set even as listeners come and go.
    let natsSub: { unsubscribe(): void } | null = null;
    (async () => {
        try {
            const { nc, codec } = await getNats();
            const subject = `ws.${runtimeWorkspaceId}.entity.${entity.$name}.${key}.state`;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            natsSub = nc.subscribe(subject) as any;
            (async () => {
                if (!natsSub) return;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                for await (const msg of natsSub as any) {
                    try {
                        const decoded = codec.decode(msg.data) as {
                            type?: string;
                            state?: Record<string, unknown>;
                        };
                        if (decoded.type === 'ENTITY_STATE' && decoded.state) {
                            sub.state = decoded.state;
                            sub.ready = true;
                            sub.error = null;
                            notify(sub);
                        }
                    } catch {
                        // Drop malformed message — keep the sub alive.
                    }
                }
            })();
        } catch (err) {
            // NATS subscription failed — the hook still works in
            // request/response mode (each action POSTs and gets the new
            // state back), just without cross-tab live updates.
            // eslint-disable-next-line no-console
            console.warn('[syncengine] entity NATS subscription failed:', err);
        }
    })();

    sub.dispose = () => {
        natsSub?.unsubscribe();
        subscriptions.delete(subKey);
    };

    return sub;
}

function notify(sub: EntitySubscription): void {
    for (const fn of sub.listeners) fn();
}

// ── Restate POST helper ────────────────────────────────────────────────────

/**
 * Invoke a Restate object handler. Returns the parsed `state` envelope
 * from the entity-runtime's `HandlerResult`. Args are sent as a JSON
 * array; an empty list serializes to `[]`. Bearer token is attached if
 * the runtime config provided one.
 */
async function invokeHandler(
    entity: AnyEntity,
    key: string,
    handlerName: string,
    args: readonly unknown[],
): Promise<Record<string, unknown>> {
    const url =
        `${runtimeRestateUrl}/entity_${entity.$name}` +
        `/${encodeURIComponent(`${runtimeWorkspaceId}/${key}`)}` +
        `/${handlerName}`;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (runtimeAuthToken) headers.authorization = `Bearer ${runtimeAuthToken}`;

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(
            `entity '${entity.$name}'.${handlerName}('${key}') failed: ${res.status} ${text}`,
        );
    }

    const body = (await res.json()) as { state: Record<string, unknown> };
    if (!body || typeof body !== 'object' || !body.state) {
        throw new Error(
            `entity '${entity.$name}'.${handlerName}('${key}') returned malformed body.`,
        );
    }
    return body.state;
}

// ── useEntity hook ─────────────────────────────────────────────────────────

/**
 * Subscribe to an entity instance and get a typed action proxy.
 *
 *     const counter = defineEntity('counter', { state: { value: integer() }, handlers: { ... } });
 *     // ...
 *     const { state, actions, ready, error } = useEntity(counter, 'global');
 *     state?.value;            // typed as number | undefined
 *     await actions.increment(5);
 */
export function useEntity<
    TName extends string,
    TShape extends EntityStateShape,
    THandlers extends EntityHandlerMap<EntityState<TShape>>,
>(
    entity: EntityDef<TName, TShape, THandlers>,
    key: string,
): UseEntityResult<EntityState<TShape>, THandlers> {
    // Memoize by (entity, key) tuple — a re-render with the same arguments
    // must reuse the same subscription. We track the last (entity, key)
    // pair via a ref and only rebuild when one of them changes.
    const subRef = useRef<EntitySubscription | null>(null);
    const lastEntityRef = useRef<AnyEntity | null>(null);
    const lastKeyRef = useRef<string | null>(null);

    if (
        lastEntityRef.current !== (entity as unknown as AnyEntity) ||
        lastKeyRef.current !== key
    ) {
        lastEntityRef.current = entity as unknown as AnyEntity;
        lastKeyRef.current = key;
        subRef.current = getOrCreateSubscription(entity as unknown as AnyEntity, key);
    }
    const sub = subRef.current!;

    // Standard external-store subscription pattern. The snapshot is the
    // subscription object itself — React only re-renders when `notify`
    // mutates one of its fields.
    const subscribe = useRef((onChange: () => void) => {
        sub.listeners.add(onChange);
        return () => {
            sub.listeners.delete(onChange);
            // Tear down the subscription when the LAST listener leaves.
            // Multiple components can share one entity subscription, so
            // we only dispose when the listener set goes empty.
            if (sub.listeners.size === 0) sub.dispose();
        };
    }).current;

    // Three separate selectors keep the snapshot stable so React's
    // bailout-on-equal works correctly.
    const stateSnapshot = useSyncExternalStore(
        subscribe,
        () => sub.state,
        () => sub.state,
    );
    const readySnapshot = useSyncExternalStore(
        subscribe,
        () => sub.ready,
        () => sub.ready,
    );
    const errorSnapshot = useSyncExternalStore(
        subscribe,
        () => sub.error,
        () => sub.error,
    );

    // Build the typed action proxy. We rebuild on every render — the
    // closure captures `entity` and `key` so it stays correct under
    // re-renders, and the proxy itself is cheap to construct.
    const actions = buildActionProxy<EntityState<TShape>, THandlers>(
        entity as unknown as AnyEntity,
        key,
        sub,
    );

    // Cleanup on unmount: useEffect with empty deps so it fires once per
    // mount and the cleanup runs on unmount only.
    useEffect(() => {
        return () => {
            // No-op here — the unsubscribe inside `subscribe` already
            // handles disposal of the underlying subscription. We keep
            // this effect so future cleanup logic has a hook.
        };
    }, []);

    return {
        state: stateSnapshot as EntityState<TShape> | null,
        actions,
        ready: readySnapshot,
        error: errorSnapshot,
    };
}

function buildActionProxy<TState, THandlers>(
    entity: AnyEntity,
    key: string,
    sub: EntitySubscription,
): ActionMap<TState, THandlers> {
    const handlerNames = Object.keys(entity.$handlers);
    const proxy: Record<string, (...args: unknown[]) => Promise<TState>> = {};
    for (const name of handlerNames) {
        proxy[name] = async (...args: unknown[]): Promise<TState> => {
            try {
                const state = await invokeHandler(entity, key, name, args);
                // The NATS broadcast also delivers this state, but we
                // optimistically apply the response to avoid a render
                // gap on slow networks. Idempotent.
                sub.state = state;
                sub.error = null;
                sub.ready = true;
                notify(sub);
                return state as TState;
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                sub.error = error;
                notify(sub);
                throw error;
            }
        };
    }
    return proxy as ActionMap<TState, THandlers>;
}
