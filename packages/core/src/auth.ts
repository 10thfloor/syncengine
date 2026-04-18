/**
 * Auth foundation — types and the Access DSL.
 *
 * This module defines the vocabulary used everywhere auth is enforced:
 * the shape of a verified user, the context an access predicate receives,
 * and the envelope (`AccessPolicy`) that Access factories produce.
 *
 * Enforcement lives elsewhere (entity runtime, gateway, client). This
 * file is pure types and predicates — no side effects, no I/O.
 */

/**
 * A verified user identity. Produced by an auth provider adapter and
 * attached to every WebSocket connection at handshake time.
 *
 * `roles` is per-workspace — the same user may have different roles in
 * different workspaces. Populated from the workspace's member list, not
 * from JWT claims.
 */
export interface AuthUser {
    readonly id: string;
    readonly email?: string;
    readonly roles?: readonly string[];
    /** Provider-supplied JWT claims (iss, aud, exp, custom). Available
     *  for custom access predicates via `Access.where(...)`. */
    readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * Context passed to every access predicate. `user` is `null` for
 * unauthenticated requests (only valid for `Access.public`). `key` is
 * the entity instance key being operated on (e.g. `'keyboard'`).
 * `state` is the current entity state, available for ownership checks.
 */
export interface AccessContext<S = Record<string, unknown>> {
    readonly user: AuthUser | null;
    readonly key: string;
    readonly state?: S;
}

/**
 * The envelope every `Access.*` factory produces. `$kind` is the brand —
 * it lets the runtime distinguish a policy from a plain boolean or
 * predicate function (both of which could be confused for a policy at
 * the user-API level).
 *
 * `check` receives `AccessContext<Record<string, unknown>>` — the state
 * type is erased at the policy boundary so heterogeneous policies can
 * share a collection. Predicates that inspect state (e.g. `Access.owner`)
 * must cast internally.
 */
export interface AccessPolicy {
    readonly $kind: 'access';
    readonly check: (ctx: AccessContext) => boolean;
}

// ── Access DSL ─────────────────────────────────────────────────────────────
//
// Composable access predicates. Every value here is either a terminal
// constant (Access.public, Access.authenticated, Access.deny) or a
// factory that returns a fresh AccessPolicy. All policies share the
// same envelope so they can be composed with `any()` / `all()` and
// evaluated uniformly by the enforcement layer.

const publicPolicy: AccessPolicy = {
    $kind: 'access',
    check: () => true,
};

const authenticatedPolicy: AccessPolicy = {
    $kind: 'access',
    check: (ctx) => ctx.user !== null,
};

const denyPolicy: AccessPolicy = {
    $kind: 'access',
    check: () => false,
};

export const Access = {
    public: publicPolicy,
    authenticated: authenticatedPolicy,
    deny: denyPolicy,
};
