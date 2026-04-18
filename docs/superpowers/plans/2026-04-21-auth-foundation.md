# Auth Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the foundational auth types and the `Access` DSL in `@syncengine/core`, plus recognize `$user` as a placeholder alongside `$key` in emit records. No runtime integration — this plan produces pure, unit-tested types and predicates that downstream plans (entity enforcement, channel access, client SDK) depend on.

**Architecture:** One new file `packages/core/src/auth.ts` defines `AuthUser`, `AccessContext`, and `AccessPolicy`. An `Access` object exposes composable access predicates (`public`, `authenticated`, `deny`, `role`, `owner`, `any`, `all`, `where`) following the same factory-function pattern as `Retry`, `Delivery`, and `Storage` in `bus-config.ts`. The emit record typing in `entity.ts` is widened to accept `'$user'` anywhere `'$key'` is already accepted.

**Tech Stack:** TypeScript, Vitest. Zero new dependencies.

**Out of scope (later plans):** enforcement of `access` policies in the entity runtime (Plan 2), provider adapters (Plan 6), client-side `useUser()` (Plan 5), workspace/channel enforcement (Plans 3 & 4).

---

## File Structure

- **Create:** `packages/core/src/auth.ts` — types (`AuthUser`, `AccessContext`, `AccessPolicy`) and the `Access` DSL object
- **Create:** `packages/core/src/__tests__/auth.test.ts` — unit tests for every `Access` primitive
- **Modify:** `packages/core/src/entity.ts:550-570` — widen the emit record typing to accept `'$user'` alongside `'$key'`
- **Modify:** `packages/core/src/index.ts` — re-export the public auth surface

---

## Task 1: Define core auth types

Introduce the type shapes that every downstream primitive references: the verified user, the evaluation context, and the policy envelope.

**Files:**
- Create: `packages/core/src/auth.ts`
- Create: `packages/core/src/__tests__/auth.test.ts`

- [ ] **Step 1: Create `auth.ts` with the type definitions (no runtime yet)**

Write the skeleton file:

```typescript
// packages/core/src/auth.ts
//
// Auth foundation — types and the Access DSL.
//
// This module defines the vocabulary used everywhere auth is enforced:
// the shape of a verified user, the context an access predicate receives,
// and the envelope (`AccessPolicy`) that Access factories produce.
//
// Enforcement lives elsewhere (entity runtime, gateway, client). This
// file is pure types and predicates — no side effects, no I/O.

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
 */
export interface AccessPolicy {
    readonly $kind: 'access';
    readonly check: (ctx: AccessContext) => boolean;
}
```

- [ ] **Step 2: Write a failing test that the types exist and can be used**

```typescript
// packages/core/src/__tests__/auth.test.ts
import { describe, it, expect } from 'vitest';
import type { AuthUser, AccessContext, AccessPolicy } from '../auth';

describe('auth types', () => {
    it('AuthUser can be constructed with id only', () => {
        const u: AuthUser = { id: 'alice' };
        expect(u.id).toBe('alice');
    });

    it('AccessContext carries user, key, and optional state', () => {
        const ctx: AccessContext<{ stock: number }> = {
            user: { id: 'alice' },
            key: 'keyboard',
            state: { stock: 10 },
        };
        expect(ctx.state?.stock).toBe(10);
    });

    it('AccessPolicy brand is literal $kind: "access"', () => {
        const policy: AccessPolicy = {
            $kind: 'access',
            check: () => true,
        };
        expect(policy.$kind).toBe('access');
    });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/auth.ts packages/core/src/__tests__/auth.test.ts
git commit -m "feat(core): auth foundation — AuthUser, AccessContext, AccessPolicy types"
```

---

## Task 2: `Access.public`, `Access.authenticated`, `Access.deny`

The three terminal constants. `public` always allows, `authenticated` requires a non-null user, `deny` always rejects.

**Files:**
- Modify: `packages/core/src/auth.ts` (append to the file)
- Modify: `packages/core/src/__tests__/auth.test.ts`

- [ ] **Step 1: Write failing tests for the three constants**

Append to `packages/core/src/__tests__/auth.test.ts`:

```typescript
import { Access } from '../auth';

describe('Access.public', () => {
    it('allows anyone, including unauthenticated', () => {
        expect(Access.public.check({ user: null, key: 'x' })).toBe(true);
        expect(Access.public.check({ user: { id: 'a' }, key: 'x' })).toBe(true);
    });

    it('is branded as an access policy', () => {
        expect(Access.public.$kind).toBe('access');
    });
});

describe('Access.authenticated', () => {
    it('allows authenticated users', () => {
        expect(Access.authenticated.check({ user: { id: 'a' }, key: 'x' })).toBe(true);
    });

    it('rejects unauthenticated requests', () => {
        expect(Access.authenticated.check({ user: null, key: 'x' })).toBe(false);
    });
});

describe('Access.deny', () => {
    it('rejects everyone, even authenticated users', () => {
        expect(Access.deny.check({ user: null, key: 'x' })).toBe(false);
        expect(Access.deny.check({ user: { id: 'a' }, key: 'x' })).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: Import of `Access` fails — `Access` not exported.

- [ ] **Step 3: Implement the three constants**

Append to `packages/core/src/auth.ts`:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: All 6 tests pass (3 from Task 1, 3 new groups from Task 2).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth.ts packages/core/src/__tests__/auth.test.ts
git commit -m "feat(core): Access.public, Access.authenticated, Access.deny"
```

---

## Task 3: `Access.role(...)` with value-object-typed roles

Role check with two call shapes: bare strings (simple), or a value def + strings (compile-time enum check).

**Files:**
- Modify: `packages/core/src/auth.ts`
- Modify: `packages/core/src/__tests__/auth.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/core/src/__tests__/auth.test.ts`:

```typescript
describe('Access.role', () => {
    it('bare-string form: passes when user has any of the listed roles', () => {
        const policy = Access.role('admin', 'member');
        expect(policy.check({ user: { id: 'a', roles: ['member'] }, key: 'x' })).toBe(true);
        expect(policy.check({ user: { id: 'a', roles: ['admin'] }, key: 'x' })).toBe(true);
    });

    it('bare-string form: rejects when user lacks every listed role', () => {
        const policy = Access.role('admin');
        expect(policy.check({ user: { id: 'a', roles: ['viewer'] }, key: 'x' })).toBe(false);
    });

    it('rejects unauthenticated users', () => {
        const policy = Access.role('admin');
        expect(policy.check({ user: null, key: 'x' })).toBe(false);
    });

    it('rejects users with no roles set', () => {
        const policy = Access.role('admin');
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(false);
    });

    it('value-def form: accepts a def with $enum plus role strings from the enum', () => {
        const RoleDef = { $enum: ['owner', 'admin', 'member', 'viewer'] as const };
        const policy = Access.role(RoleDef, 'admin');
        expect(policy.check({ user: { id: 'a', roles: ['admin'] }, key: 'x' })).toBe(true);
        expect(policy.check({ user: { id: 'a', roles: ['viewer'] }, key: 'x' })).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: Tests fail — `Access.role is not a function`.

- [ ] **Step 3: Implement `Access.role` with overloads**

Append to the `Access` object in `packages/core/src/auth.ts`. Replace the existing `Access` export with:

```typescript
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
    ...allowed: E[number][]
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
    ...allowed: E[number][]
): AccessPolicy;
function role(...allowed: [string, ...string[]]): AccessPolicy;
function role(
    defOrFirst: RoleEnumCarrier<readonly string[]> | string,
    ...rest: string[]
): AccessPolicy {
    if (typeof defOrFirst === 'string') {
        return roleBare(defOrFirst, ...rest);
    }
    return roleTyped(defOrFirst, ...rest);
}

export const Access = {
    public: publicPolicy,
    authenticated: authenticatedPolicy,
    deny: denyPolicy,
    role,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: 5 new tests pass (plus existing 6).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth.ts packages/core/src/__tests__/auth.test.ts
git commit -m "feat(core): Access.role with value-def overload for typed roles"
```

---

## Task 4: `Access.owner()` with optional field name

Ownership check — passes when the entity state's `userId` (or a configurable field) matches the authenticated user's `id`.

**Files:**
- Modify: `packages/core/src/auth.ts`
- Modify: `packages/core/src/__tests__/auth.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/core/src/__tests__/auth.test.ts`:

```typescript
describe('Access.owner', () => {
    it('passes when state.userId equals user.id (default field)', () => {
        const policy = Access.owner();
        const ctx: AccessContext<{ userId: string }> = {
            user: { id: 'alice' },
            key: 'order-1',
            state: { userId: 'alice' },
        };
        expect(policy.check(ctx)).toBe(true);
    });

    it('rejects when state.userId differs from user.id', () => {
        const policy = Access.owner();
        const ctx: AccessContext<{ userId: string }> = {
            user: { id: 'alice' },
            key: 'order-1',
            state: { userId: 'bob' },
        };
        expect(policy.check(ctx)).toBe(false);
    });

    it('uses the configured field name when provided', () => {
        const policy = Access.owner('createdBy');
        const ctx: AccessContext<{ createdBy: string }> = {
            user: { id: 'alice' },
            key: 'doc-1',
            state: { createdBy: 'alice' },
        };
        expect(policy.check(ctx)).toBe(true);
    });

    it('rejects unauthenticated users', () => {
        const policy = Access.owner();
        const ctx: AccessContext<{ userId: string }> = {
            user: null,
            key: 'order-1',
            state: { userId: 'alice' },
        };
        expect(policy.check(ctx)).toBe(false);
    });

    it('rejects when state is missing', () => {
        const policy = Access.owner();
        expect(policy.check({ user: { id: 'alice' }, key: 'order-1' })).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: Tests fail — `Access.owner is not a function`.

- [ ] **Step 3: Implement `Access.owner`**

Add `owner` to the `Access` export in `packages/core/src/auth.ts`. Insert the factory above the `Access` export:

```typescript
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
```

And update the `Access` export:

```typescript
export const Access = {
    public: publicPolicy,
    authenticated: authenticatedPolicy,
    deny: denyPolicy,
    role,
    owner,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: All 5 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth.ts packages/core/src/__tests__/auth.test.ts
git commit -m "feat(core): Access.owner() — ownership check against state field"
```

---

## Task 5: `Access.any(...)` and `Access.all(...)` composition

Boolean combinators. `any` is OR, `all` is AND. Both short-circuit.

**Files:**
- Modify: `packages/core/src/auth.ts`
- Modify: `packages/core/src/__tests__/auth.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/core/src/__tests__/auth.test.ts`:

```typescript
describe('Access.any', () => {
    it('passes when at least one policy passes', () => {
        const policy = Access.any(Access.deny, Access.authenticated);
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(true);
    });

    it('rejects when every policy rejects', () => {
        const policy = Access.any(Access.deny, Access.deny);
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(false);
    });

    it('short-circuits on first pass', () => {
        let evaluated = 0;
        const countingPolicy: AccessPolicy = {
            $kind: 'access',
            check: () => { evaluated++; return true; },
        };
        const policy = Access.any(countingPolicy, countingPolicy);
        policy.check({ user: null, key: 'x' });
        expect(evaluated).toBe(1);
    });

    it('empty list rejects (vacuous any)', () => {
        const policy = Access.any();
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(false);
    });
});

describe('Access.all', () => {
    it('passes when every policy passes', () => {
        const policy = Access.all(Access.public, Access.authenticated);
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(true);
    });

    it('rejects when any policy rejects', () => {
        const policy = Access.all(Access.authenticated, Access.deny);
        expect(policy.check({ user: { id: 'a' }, key: 'x' })).toBe(false);
    });

    it('short-circuits on first reject', () => {
        let evaluated = 0;
        const countingPolicy: AccessPolicy = {
            $kind: 'access',
            check: () => { evaluated++; return false; },
        };
        const policy = Access.all(countingPolicy, countingPolicy);
        policy.check({ user: null, key: 'x' });
        expect(evaluated).toBe(1);
    });

    it('empty list passes (vacuous all)', () => {
        const policy = Access.all();
        expect(policy.check({ user: null, key: 'x' })).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: Tests fail — `Access.any is not a function`.

- [ ] **Step 3: Implement `Access.any` and `Access.all`**

Add the factories above the `Access` export in `packages/core/src/auth.ts`:

```typescript
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
```

Update the `Access` export:

```typescript
export const Access = {
    public: publicPolicy,
    authenticated: authenticatedPolicy,
    deny: denyPolicy,
    role,
    owner,
    any,
    all,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: 8 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth.ts packages/core/src/__tests__/auth.test.ts
git commit -m "feat(core): Access.any / Access.all with short-circuit composition"
```

---

## Task 6: `Access.where(...)` — custom predicate escape hatch

For cases the built-ins don't cover. Receives the authenticated user and entity key directly.

**Files:**
- Modify: `packages/core/src/auth.ts`
- Modify: `packages/core/src/__tests__/auth.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/core/src/__tests__/auth.test.ts`:

```typescript
describe('Access.where', () => {
    it('passes when the predicate returns true', () => {
        const policy = Access.where((user, key) => user?.id === 'alice' && key === 'keyboard');
        expect(policy.check({ user: { id: 'alice' }, key: 'keyboard' })).toBe(true);
    });

    it('rejects when the predicate returns false', () => {
        const policy = Access.where((user) => user?.id === 'alice');
        expect(policy.check({ user: { id: 'bob' }, key: 'keyboard' })).toBe(false);
    });

    it('passes null user through to the predicate', () => {
        const policy = Access.where((user) => user === null);
        expect(policy.check({ user: null, key: 'x' })).toBe(true);
    });

    it('composes with any() and all()', () => {
        const isInternalKey = Access.where((_, key) => key.startsWith('internal-'));
        const policy = Access.all(Access.authenticated, isInternalKey);
        expect(policy.check({ user: { id: 'a' }, key: 'internal-1' })).toBe(true);
        expect(policy.check({ user: { id: 'a' }, key: 'public-1' })).toBe(false);
        expect(policy.check({ user: null, key: 'internal-1' })).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: Tests fail — `Access.where is not a function`.

- [ ] **Step 3: Implement `Access.where`**

Add the factory above the `Access` export in `packages/core/src/auth.ts`:

```typescript
function where(
    predicate: (user: AuthUser | null, key: string) => boolean,
): AccessPolicy {
    return {
        $kind: 'access',
        check: (ctx) => predicate(ctx.user, ctx.key),
    };
}
```

Update the `Access` export:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: 4 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth.ts packages/core/src/__tests__/auth.test.ts
git commit -m "feat(core): Access.where — custom predicate escape hatch"
```

---

## Task 7: Recognize `$user` as an emit-record placeholder

Widen the emit record typing so `'$user'` is accepted anywhere `'$key'` already is. Runtime resolution comes in Plan 2 — this task is purely about the type surface and a runtime-neutral const export.

**Files:**
- Modify: `packages/core/src/auth.ts` — export `USER_PLACEHOLDER` constant
- Modify: `packages/core/src/entity.ts:550-570` — widen `EmitRecord` comment + type to mention `$user`
- Modify: `packages/core/src/__tests__/auth.test.ts`

- [ ] **Step 1: Write failing test for the constant**

Append to `packages/core/src/__tests__/auth.test.ts`:

```typescript
import { USER_PLACEHOLDER } from '../auth';

describe('USER_PLACEHOLDER', () => {
    it('is the literal string "$user"', () => {
        expect(USER_PLACEHOLDER).toBe('$user');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: Import fails — `USER_PLACEHOLDER` not exported.

- [ ] **Step 3: Export `USER_PLACEHOLDER` and document it**

Append to `packages/core/src/auth.ts` (before the `Access` export, after the type definitions):

```typescript
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
```

- [ ] **Step 4: Update `entity.ts` comment at line ~554 to mention `$user`**

Open `packages/core/src/entity.ts` and find the block around lines 552-570 (the `EmitRecord` helper comment). Currently reads:

```typescript
/** Helper: for each field in a table's record, make it optional and
 *  widen string columns to accept any `string` (including the `'$key'`
 *  placeholder the entity runtime resolves at publish time). Enum
 *  strictness is intentionally relaxed — handler params are typically
```

Replace with:

```typescript
/** Helper: for each field in a table's record, make it optional and
 *  widen string columns to accept any `string` (including the `'$key'`
 *  and `'$user'` placeholders the entity runtime resolves at publish
 *  time). Enum strictness is intentionally relaxed — handler params
 *  are typically
```

This is a comment-only change; the existing type widens to `string`, which already accepts any literal including `'$user'`. The runtime substitution logic arrives in Plan 2 (enforcement).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @syncengine/core test auth -- --run`

Expected: All auth tests pass.

- [ ] **Step 6: Run the full core test suite to confirm no regression**

Run: `pnpm --filter @syncengine/core test -- --run`

Expected: Entire suite passes.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/auth.ts packages/core/src/entity.ts packages/core/src/__tests__/auth.test.ts
git commit -m "feat(core): USER_PLACEHOLDER constant — '\$user' in emit records"
```

---

## Task 8: Re-export the auth surface from `packages/core/src/index.ts`

Make the new types and `Access` DSL part of the public `@syncengine/core` / `hexo` import path.

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Check the current structure of `index.ts`**

Run: `grep -n "^export" packages/core/src/index.ts | head -30`

Expected: Shows the existing re-export block.

- [ ] **Step 2: Add the auth re-exports**

Open `packages/core/src/index.ts`. Near the other type/DSL re-exports (look for `export { Retention, Delivery, Storage, ... }` from `bus-config` for reference placement), add:

```typescript
// ── Auth foundation ────────────────────────────────────────────────────────
export {
    Access,
    USER_PLACEHOLDER,
} from './auth';
export type {
    AuthUser,
    AccessContext,
    AccessPolicy,
    RoleEnumCarrier,
} from './auth';
```

- [ ] **Step 3: Write a smoke test that the public API resolves**

Create `packages/core/src/__tests__/auth-public-api.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Access, USER_PLACEHOLDER } from '../index';
import type { AuthUser, AccessPolicy } from '../index';

describe('public auth API', () => {
    it('Access is importable from the package root', () => {
        expect(typeof Access.public).toBe('object');
        expect(typeof Access.role).toBe('function');
    });

    it('USER_PLACEHOLDER is exported as "$user"', () => {
        expect(USER_PLACEHOLDER).toBe('$user');
    });

    it('AuthUser and AccessPolicy types are importable', () => {
        const u: AuthUser = { id: 'a' };
        const p: AccessPolicy = Access.public;
        expect(u.id).toBe('a');
        expect(p.$kind).toBe('access');
    });
});
```

- [ ] **Step 4: Run the smoke test**

Run: `pnpm --filter @syncengine/core test auth-public-api -- --run`

Expected: 3 tests pass.

- [ ] **Step 5: Run the full core test suite**

Run: `pnpm --filter @syncengine/core test -- --run`

Expected: Entire suite passes. No pre-existing tests regress.

- [ ] **Step 6: Type-check the workspace to catch downstream breakage**

Run: `pnpm --filter @syncengine/core exec tsc --noEmit`

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/__tests__/auth-public-api.test.ts
git commit -m "feat(core): export auth foundation from package root"
```

---

## Task 9: Verify full workspace build

Sanity check: the new module doesn't break any downstream package's type-check or tests.

**Files:** none modified

- [ ] **Step 1: Full workspace build**

Run: `pnpm -w build`

Expected: Every package builds clean.

- [ ] **Step 2: Full workspace test**

Run: `pnpm -w test`

Expected: Every package's tests pass. If anything regresses, the plan has missed something — stop and investigate.

- [ ] **Step 3: Nothing to commit here**

This is a verification task only. If steps 1-2 pass, the plan is complete.

---

## Definition of Done

- `packages/core/src/auth.ts` exists with `AuthUser`, `AccessContext`, `AccessPolicy`, `RoleEnumCarrier`, `USER_PLACEHOLDER`, and `Access` (with `public`, `authenticated`, `deny`, `role`, `owner`, `any`, `all`, `where`).
- Every `Access.*` primitive has unit tests covering the happy path, rejection path, and composition where relevant.
- `USER_PLACEHOLDER` exported; `entity.ts` comment updated to mention `$user` alongside `$key`.
- Public API importable from `@syncengine/core` / `hexo`.
- Full workspace build and test suite pass.

## What This Plan Does NOT Do

- **No enforcement.** Access policies are not yet evaluated before handler dispatch — that's Plan 2.
- **No runtime `$user` substitution.** The placeholder is recognised at the type level and has a constant for downstream use; actual substitution at emit time lands in Plan 2.
- **No provider adapters, no WebSocket handshake, no client hook.** Those are Plans 3, 5, and 6.

## Subsequent Plans

| # | Plan | What it adds |
|---|------|-------------|
| 2 | Entity Access Enforcement | `access` block on entity defs, runtime evaluation, `$user` substitution, permission-denied rebase |
| 3 | Workspace + Connection Auth | `AuthProvider` port, WebSocket handshake, workspace membership check |
| 4 | Channel Access | Subscription-time access predicate on channels |
| 5 | Client SDK | `useUser()` hook, token lifecycle, `AccessDeniedError` |
| 6 | Provider Adapters | `@hexo/auth-custom` (JWT), Clerk adapter pattern |
