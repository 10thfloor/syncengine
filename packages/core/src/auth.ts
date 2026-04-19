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

/**
 * Placeholder string recognised by the entity runtime in `emit()`
 * records. Resolves to the authenticated user's `id` at publish time.
 *
 * Example — record who bought the item without a handler argument:
 *
 *   effects: [
 *     insert(transactions, {
 *       productSlug: '$key',
 *       userId:      '$user',   // resolved server-side from the connection
 *       amount:      price,
 *     }),
 *   ]
 *
 * Same lifecycle as `'$key'`: the type system widens `string` columns
 * to accept the literal, and the entity runtime substitutes the real
 * value before the row is published to NATS.
 */
export const USER_PLACEHOLDER = '$user' as const;

/**
 * Reserved user id for workflow-initiated (and other framework-internal)
 * entity calls. When the runtime sees this id, it:
 *   - skips access policy enforcement (the caller is system-privileged)
 *   - substitutes `'$user'` placeholders in emits with `'$system'` so
 *     the audit trail shows the action was taken by framework code
 *
 * Client-supplied user ids can never take this value — the string
 * starts with `$` which is reserved (same rule as entity names).
 */
export const SYSTEM_USER_ID = '$system' as const;

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

/**
 * Minimal shape a value-object-like def exposes to give `Access.role` a
 * typed role list. Any object with `$enum: readonly string[]` works —
 * a real `defineValue(..., text({ enum: [...] }))` result satisfies
 * this once it's updated to surface `$enum` (deferred to the value-
 * object integration plan).
 */
export interface RoleEnumCarrier<E extends readonly string[]> {
    readonly $enum: E;
}

function roleBare(...allowed: [string, ...string[]]): AccessPolicy {
    return {
        $kind: 'access',
        check: (ctx) => {
            if (!ctx.user?.roles) return false;
            return allowed.some((r) => ctx.user!.roles!.includes(r));
        },
    };
}

function roleTyped<E extends readonly string[]>(
    _def: RoleEnumCarrier<E>,
    ...allowed: [E[number], ...E[number][]]
): AccessPolicy {
    return {
        $kind: 'access',
        check: (ctx) => {
            if (!ctx.user?.roles) return false;
            return allowed.some((r) => ctx.user!.roles!.includes(r));
        },
    };
}

function role<E extends readonly string[]>(
    def: RoleEnumCarrier<E>,
    ...allowed: [E[number], ...E[number][]]
): AccessPolicy;
function role(...allowed: [string, ...string[]]): AccessPolicy;
function role(
    defOrFirst: RoleEnumCarrier<readonly string[]> | string,
    ...rest: string[]
): AccessPolicy {
    if (typeof defOrFirst === 'string') {
        return roleBare(defOrFirst, ...rest);
    }
    // Overload enforces at-least-one role at the public boundary; internal
    // dispatch casts to match the tuple signature.
    return roleTyped(defOrFirst, ...(rest as [string, ...string[]]));
}

function owner(field: string = 'userId'): AccessPolicy {
    return {
        $kind: 'access',
        check: (ctx) => {
            if (!ctx.user || !ctx.state) return false;
            const fieldValue = (ctx.state as Record<string, unknown>)[field];
            return fieldValue === ctx.user.id;
        },
    };
}

function any(...policies: AccessPolicy[]): AccessPolicy {
    return {
        $kind: 'access',
        check: (ctx) => {
            for (const p of policies) {
                if (p.check(ctx)) return true;
            }
            return false;
        },
    };
}

function all(...policies: AccessPolicy[]): AccessPolicy {
    return {
        $kind: 'access',
        check: (ctx) => {
            for (const p of policies) {
                if (!p.check(ctx)) return false;
            }
            return true;
        },
    };
}

function where(
    predicate: (user: AuthUser | null, key: string) => boolean,
): AccessPolicy {
    return {
        $kind: 'access',
        check: (ctx) => predicate(ctx.user, ctx.key),
    };
}

export const Access = {
    public: publicPolicy,
    authenticated: authenticatedPolicy,
    deny: denyPolicy,
    role,
    owner,
    any,
    all,
    where,
};
