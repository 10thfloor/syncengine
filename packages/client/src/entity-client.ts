/// <reference path="./runtime-config.d.ts" />

// ── Entity Client (Phase 4 + 4b) ────────────────────────────────────────────
//
// `useEntity(def, key)` is the React surface for an entity instance. It:
//
//   1. POSTs to Restate's `_read` handler on first mount to fetch the
//      current state, seeded from `def.$initialState` if Restate has no
//      record yet.
//   2. Subscribes to the per-instance NATS subject
//      `ws.{workspaceId}.entity.{name}.{key}.state` for live updates
//      published whenever any client invokes a handler.
//   3. Exposes `actions.{handlerName}(...args)` proxies that run the
//      handler LOCALLY first (optimistic UI), queue it as pending, POST
//      to Restate, and reconcile with the confirmed server state when the
//      response (or a NATS broadcast) arrives.
//   4. Shares one subscription per `(entityType, entityKey)` across every
//      hook in the same tab. Last listener to unmount tears it down.
//
// ── Latency compensation (Phase 4b) ────────────────────────────────────────
//
// Each subscription carries three layers:
//
//   confirmed    — the last server-authoritative state (from _read or a NATS
//                  broadcast)
//   pending      — queue of in-flight { handlerName, args } actions fired by
//                  this tab but not yet confirmed by the server
//   optimistic   — `confirmed` with every pending action re-run on top, in
//                  order (via the shared `rebase` helper from core)
//
// The hook returns `optimistic`. Whenever `confirmed` changes (NATS update
// or our own POST response) or `pending` is edited, we rebase — which
// re-runs every still-pending handler against the new confirmed state.
// That handles the concurrent-write case cleanly: if a remote mutation
// arrives via NATS while your own action is in flight, the rebase folds
// your handler over the NEW confirmed state, not the stale guess.
//
// Pure functional handlers (the defineEntity contract) make this safe:
// the same code runs on the client and the server, so the optimistic
// guess matches the authoritative result modulo concurrent writes.

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
    applyHandler,
    rebase,
    type AnyEntity,
    type EntityDef,
    type EntityState,
    type EntityStateShape,
    type EntityHandlerMap,
    type EntityHandler,
    type PendingActionLike,
} from '@syncengine/core';
import {
    workspaceId as runtimeWorkspaceId,
    natsUrl as runtimeNatsUrl,
    authToken as runtimeAuthToken,
    // eslint-disable-next-line import/no-unresolved
} from 'virtual:syncengine/runtime-config';

// ── Public types ────────────────────────────────────────────────────────────

/** What `useEntity(def, key)` returns. */
export interface UseEntityResult<TState, THandlers> {
    /**
     * Current optimistic state — `confirmed` with every in-flight local
     * action re-run on top. `null` until the first read completes.
     * Under zero pending actions this equals the server-confirmed state.
     */
    readonly state: TState | null;
    /** Per-handler invocation proxies. Each method runs the handler
     *  locally for instant UI, POSTs to Restate, and resolves with the
     *  confirmed state (or rejects on local/server failure). */
    readonly actions: ActionMap<TState, THandlers>;
    /** True after the initial read has completed. */
    readonly ready: boolean;
    /** Last handler error, if any. Cleared on the next successful call. */
    readonly error: Error | null;
    /** Number of in-flight local actions that haven't been confirmed yet.
     *  Useful for showing a "saving" indicator in the UI. */
    readonly pending: number;
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

interface PendingAction extends PendingActionLike {
    readonly id: number;
}

interface EntitySubscription {
    /** The last server-authoritative state (initial read or NATS broadcast). */
    confirmed: Record<string, unknown> | null;
    /** `confirmed` with every pending action folded on top. Returned by
     *  the hook so the UI is always optimistic. */
    optimistic: Record<string, unknown> | null;
    /** In-flight local actions that have been fired against this
     *  subscription but not yet confirmed by the server. Rebased on every
     *  confirmed-state change. */
    pending: PendingAction[];
    error: Error | null;
    ready: boolean;
    listeners: Set<() => void>;
    /** Monotonic id for tagging pending actions. Restart-safe because
     *  entity subscriptions are per-tab and per-(type, key). */
    nextActionId: number;
}

/**
 * Entity subscription cache, keyed by `${entity.$name}:${entityKey}`.
 *
 * ⚠️  Assumption: the tab only ever talks to ONE workspace — the one
 * resolved from the `<meta name="syncengine-workspace-id">` tag at
 * boot time, exposed as `runtimeWorkspaceId`. That assumption is
 * load-bearing for both this map and the NATS subject construction
 * below. If a future phase allows a single tab to hold multiple
 * workspaces (e.g. an admin view showing data from two users at
 * once), this key and every `ws.${runtimeWorkspaceId}.*` subject
 * need a workspace-id prefix, and the lazy NATS connection below
 * needs one instance per workspace.
 */
const subscriptions = new Map<string, EntitySubscription>();

/**
 * A lazy NATS connection shared across all entity subscriptions. The
 * promise is nulled on connection close so the next caller reconnects
 * — without this, a transient NATS outage would permanently break
 * subsequent mounts with a settled-rejected cache entry.
 */
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
            try {
                const nc = await connect({ servers: runtimeNatsUrl });
                const codec = JSONCodec();
                // Reset the cached promise when the connection closes,
                // either gracefully or on error. The next getNats() call
                // will re-dial.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                void (nc as any).closed().then(() => {
                    natsConnPromise = null;
                }).catch(() => {
                    natsConnPromise = null;
                });
                return { nc, codec };
            } catch (err) {
                // Connection failed outright — reset the cache so the
                // next call can retry instead of returning this
                // settled-rejected promise forever.
                natsConnPromise = null;
                throw err;
            }
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
        confirmed: null,
        optimistic: null,
        pending: [],
        error: null,
        ready: false,
        listeners: new Set(),
        nextActionId: 1,
    };
    subscriptions.set(subKey, sub);

    // 1. Initial read via Restate POST `_read`. The result seeds
    //    `confirmed` so the first render has authoritative data; any
    //    actions already queued (rare — would require a synchronous
    //    dispatch during the mount) get rebased on top.
    void invokeHandler(entity, key, '_read', [])
        .then((state) => {
            setConfirmed(sub, entity, state);
            sub.ready = true;
            notify(sub);
        })
        .catch((err: unknown) => {
            sub.error = err instanceof Error ? err : new Error(String(err));
            sub.ready = true;
            notify(sub);
        });

    // 2. Subscribe to the per-instance NATS subject for live updates
    //    from other clients. Each arriving state update replaces our
    //    `confirmed` base and triggers a rebase of still-pending actions.
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
                            setConfirmed(sub, entity, decoded.state);
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
    void natsSub;

    // Subscriptions intentionally live for the tab lifetime. Earlier
    // versions disposed on last-listener-removed, but that races with
    // React StrictMode's double-mount (subscribe → cleanup → subscribe)
    // and with prop changes that swap `(entity, key)` out from under
    // the listener set. Holding on to a handful of per-(type, key)
    // state objects is cheap; the handler bodies and NATS traffic are
    // the actual cost centers, and both are already shared across
    // consumers of the same subscription.

    return sub;
}

/** Atomically replace the confirmed state and rebase any pending actions
 *  on top of it. Also prunes any pending actions that fail the rebase
 *  (they'll be resolved/rejected by their in-flight server response). */
function setConfirmed(
    sub: EntitySubscription,
    entity: AnyEntity,
    next: Record<string, unknown>,
): void {
    sub.confirmed = next;
    const result = rebase(entity, sub.confirmed, sub.pending);
    sub.optimistic = result.state;
    // If any pending actions failed during rebase, drop them from the
    // queue by their stable id. The in-flight POST for each still
    // carries the authoritative verdict — dropping from the optimistic
    // chain just means the UI reflects the pre-action state until the
    // server responds.
    if (result.failedIds.length > 0) {
        const failedSet = new Set(result.failedIds);
        sub.pending = sub.pending.filter((a) => !failedSet.has(a.id));
    }
}

/** Rebase after a pending action is added, removed, or after confirmed
 *  changes. Separate from `setConfirmed` so callers can rebase without
 *  replacing the base (e.g., after dequeueing a resolved action). */
function rebaseSub(sub: EntitySubscription, entity: AnyEntity): void {
    const result = rebase(entity, sub.confirmed, sub.pending);
    sub.optimistic = result.state;
    if (result.failedIds.length > 0) {
        const failedSet = new Set(result.failedIds);
        sub.pending = sub.pending.filter((a) => !failedSet.has(a.id));
    }
}

function notify(sub: EntitySubscription): void {
    for (const fn of sub.listeners) fn();
}

// ── RPC helper (PLAN Phase 4 — via dev middleware) ────────────────────────

/**
 * Invoke a handler via the framework's RPC transport. In dev, this POSTs
 * to `/__syncengine/rpc/<entity>/<key>/<handler>` — a same-origin URL
 * that the `@syncengine/vite-plugin` dev middleware forwards to the
 * framework's Restate entity runtime. The browser never needs to know
 * the Restate URL.
 *
 * Returns the parsed `state` envelope from the entity-runtime's
 * `HandlerResult`. Args are sent as a JSON array; an empty list
 * serializes to `[]`. Bearer token is attached if the runtime config
 * provided one (future: workspace token).
 */
async function invokeHandler(
    entity: AnyEntity,
    key: string,
    handlerName: string,
    args: readonly unknown[],
): Promise<Record<string, unknown>> {
    const url =
        `/__syncengine/rpc/${entity.$name}` +
        `/${encodeURIComponent(key)}` +
        `/${handlerName}`;

    const headers: Record<string, string> = {
        'content-type': 'application/json',
        // PLAN Phase 8: tell the dev middleware which workspace to
        // target. The wsKey was resolved per-request by the plugin's
        // workspaces sub-plugin and injected into the HTML as a meta
        // tag; the runtime-config virtual module read it at boot and
        // exported it as `workspaceId`, so this header is always
        // accurate for the current user session.
        'x-syncengine-workspace': runtimeWorkspaceId,
    };
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

    // Standard external-store subscription pattern. `subscribe` must be
    // rebuilt whenever `sub` changes (e.g., the caller passed a different
    // `(entity, key)`) — otherwise the closure would hold on to the old
    // subscription object and React would send notifications to the
    // wrong listener set. `useCallback` with `[sub]` deps makes
    // `useSyncExternalStore` re-subscribe on the new sub when the
    // identity flips.
    //
    // No sub teardown here — see `getOrCreateSubscription` for the
    // "subscriptions live for the tab lifetime" rationale.
    const subscribe = useCallback(
        (onChange: () => void) => {
            sub.listeners.add(onChange);
            return () => {
                sub.listeners.delete(onChange);
            };
        },
        [sub],
    );

    // Separate selectors keep snapshots stable so React's
    // bailout-on-equal works correctly. We surface the OPTIMISTIC state
    // (confirmed + pending actions folded on top) so callers see the
    // latency-compensated view of the entity.
    const stateSnapshot = useSyncExternalStore(
        subscribe,
        () => sub.optimistic,
        () => sub.optimistic,
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
    const pendingSnapshot = useSyncExternalStore(
        subscribe,
        () => sub.pending.length,
        () => sub.pending.length,
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
        pending: pendingSnapshot,
    };
}

/**
 * Build the typed action proxy for a subscription. Each proxy method
 * performs the three-phase latency-compensated flow:
 *
 *   1. Run the handler LOCALLY on the current optimistic state. If it
 *      throws, reject immediately — client state is our best estimate
 *      of what the server will do, and a deterministic local failure
 *      saves a round-trip.
 *   2. Push the call to `pending`, rebase to update `optimistic`, and
 *      notify React. The UI shows the new state instantly.
 *   3. POST to Restate in the background. On success, drop our pending
 *      entry, set `confirmed` to the server response, rebase, notify,
 *      and resolve. On failure, drop our pending entry, rebase (so the
 *      UI rolls back), notify, and reject with the server error.
 *
 * The shared `rebase` helper from core handles the tricky case where a
 * NATS broadcast from another client arrives while our POST is in
 * flight: on each incoming `confirmed` change we re-run still-pending
 * handlers on the new base, so our optimistic view stays consistent
 * with what the server will ultimately compute.
 */
function buildActionProxy<TState, THandlers>(
    entity: AnyEntity,
    key: string,
    sub: EntitySubscription,
): ActionMap<TState, THandlers> {
    const handlerNames = Object.keys(entity.$handlers);
    const proxy: Record<string, (...args: unknown[]) => Promise<TState>> = {};

    for (const name of handlerNames) {
        proxy[name] = async (...args: unknown[]): Promise<TState> => {
            // ── Phase 1: run locally for optimistic rebase (best effort) ──
            //
            // When the client has a copy of the handler code (pure-state
            // entities, my Phase 4b latency comp), running the handler
            // against the current optimistic base gives us an instant
            // preview that the subsequent POST will reconcile.
            //
            // When the handler body has been stripped by the Vite plugin
            // (PLAN Phase 4 server-only actors), the stub is a no-op that
            // returns the state unchanged — harmless. If, for some reason,
            // the local call throws (e.g., an older stub form, or a real
            // server-only validation error), we swallow it and proceed to
            // the POST path. In a server-only world the authoritative
            // decision is always the server's, so a local throw is not
            // enough to reject the caller.
            if (sub.confirmed !== null) {
                const base = sub.optimistic ?? sub.confirmed;
                try {
                    applyHandler(entity, name, base, args);
                } catch {
                    // Local run failed — no optimistic preview is possible.
                    // Proceed to the POST path; the server decides.
                }
            }

            // ── Phase 2: enqueue, rebase, notify ─────────────────────────
            const action: PendingAction = {
                id: sub.nextActionId++,
                handlerName: name,
                args,
            };
            sub.pending.push(action);
            rebaseSub(sub, entity);
            sub.error = null;
            notify(sub);

            // ── Phase 3: POST to Restate, reconcile on response ──────────
            try {
                const confirmedState = await invokeHandler(entity, key, name, args);
                // Drop our entry from pending before rebasing — otherwise
                // it would get double-applied on top of the new confirmed.
                sub.pending = sub.pending.filter((a) => a.id !== action.id);
                setConfirmed(sub, entity, confirmedState);
                sub.ready = true;
                notify(sub);
                return confirmedState as TState;
            } catch (err) {
                // Drop the failed action; rebase so optimistic reflects
                // the remaining pending chain on top of unchanged confirmed.
                sub.pending = sub.pending.filter((a) => a.id !== action.id);
                rebaseSub(sub, entity);
                const error = err instanceof Error ? err : new Error(String(err));
                sub.error = error;
                notify(sub);
                throw error;
            }
        };
    }

    return proxy as ActionMap<TState, THandlers>;
}
