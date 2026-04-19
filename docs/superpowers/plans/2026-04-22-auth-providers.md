# Auth — Provider Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship two production-ready reference adapters: a JWT verifier built on the `jose` library (pluggable to any OIDC issuer), and documentation plus a worked example for a named OIDC provider (Clerk). Close out the auth spec.

**Architecture:** Two new modules in `@syncengine/server`:
- `auth/jwt-adapter.ts` — `jwt({ jwksUri | publicKey, issuer?, audience? })` verifies RS256/ES256 JWTs using `jose`. Returns `AuthUser.id` from the `sub` claim, `email` from the `email` claim, and the full payload as `claims`.
- `auth/clerk-adapter.ts` — a thin wrapper around `jwt()` configured for Clerk's JWKS. Same shape, easier defaults.

Client side, no new code — apps write a ~10-line `AuthClient` adapter against their frontend auth SDK (Clerk's `@clerk/clerk-react`, Auth0's `@auth0/auth0-react`, etc.) as documented in the auth guide.

**Tech Stack:** TypeScript, Vitest, `jose` (JWT library — already transitively available, add if missing).

**Out of scope:**
- Gateway-side workspace role lookup (flagged in Plan 4 — a separate refactor to add a Restate ingress workspace client in serve.ts)
- Native SDK wrappers for other providers (Auth0, Descope, Supabase Auth) — each is a 30-line fork of the clerk adapter and can land as community modules

---

## File Structure

- **Create:** `packages/server/src/auth/jwt-adapter.ts` — generic JWKS/public-key verifier
- **Create:** `packages/server/src/auth/clerk-adapter.ts` — Clerk-tuned preset
- **Create:** `packages/server/src/__tests__/auth/jwt-adapter.test.ts`
- **Create:** `packages/server/src/__tests__/auth/clerk-adapter.test.ts`
- **Modify:** `packages/server/package.json` — add `jose` dependency
- **Modify:** `packages/server/src/index.ts` — re-export the adapters
- **Create:** `docs/guides/auth.md` — developer-facing guide covering server + client integration

---

## Task 1: Add `jose` dependency

**Files:**
- Modify: `packages/server/package.json`

- [ ] **Step 1: Check if `jose` is already installed**

Run: `pnpm list jose`

Likely installed as a transitive dep from another package. If not, add it:

```bash
pnpm --filter @syncengine/server add jose
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml
git commit -m "chore(server): add jose dependency for JWT verification"
```

---

## Task 2: `jwt()` adapter — generic JWKS / public-key verifier

**Files:**
- Create: `packages/server/src/auth/jwt-adapter.ts`
- Create: `packages/server/src/__tests__/auth/jwt-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

Use `jose`'s `SignJWT` in the test harness to generate signed tokens, then verify them through the adapter.

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, type JWK } from 'jose';
import { jwt } from '../../auth/jwt-adapter';

describe('jwt() adapter', () => {
    let publicJwk: JWK;
    let signToken: (claims: Record<string, unknown>) => Promise<string>;

    beforeAll(async () => {
        const { publicKey, privateKey } = await generateKeyPair('RS256');
        publicJwk = await exportJWK(publicKey);
        publicJwk.alg = 'RS256';
        publicJwk.use = 'sig';
        signToken = async (claims) =>
            await new SignJWT({ ...claims })
                .setProtectedHeader({ alg: 'RS256' })
                .setIssuedAt()
                .setExpirationTime('1h')
                .sign(privateKey);
    });

    it('verifies a well-formed token with publicKey option', async () => {
        const provider = jwt({ publicKey: publicJwk });
        const token = await signToken({ sub: 'alice', email: 'a@example.com' });
        const result = await provider.verify(token);
        expect(result).toEqual({ ok: true, user: expect.objectContaining({ id: 'alice', email: 'a@example.com' }) });
    });

    it('rejects an expired token', async () => {
        const provider = jwt({ publicKey: publicJwk });
        const expired = await new SignJWT({ sub: 'alice' })
            .setProtectedHeader({ alg: 'RS256' })
            .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
            .sign((await generateKeyPair('RS256')).privateKey);
        const result = await provider.verify(expired);
        expect(result.ok).toBe(false);
    });

    it('enforces issuer when configured', async () => {
        const provider = jwt({ publicKey: publicJwk, issuer: 'https://issuer.example' });
        const wrongIssuer = await signToken({ sub: 'a', iss: 'https://other.example' });
        const result = await provider.verify(wrongIssuer);
        expect(result.ok).toBe(false);
    });

    it('enforces audience when configured', async () => {
        const provider = jwt({ publicKey: publicJwk, audience: 'my-api' });
        const wrongAud = await signToken({ sub: 'a', aud: 'other-api' });
        const result = await provider.verify(wrongAud);
        expect(result.ok).toBe(false);
    });

    it('surfaces the full payload as claims', async () => {
        const provider = jwt({ publicKey: publicJwk });
        const token = await signToken({ sub: 'alice', custom: 'value' });
        const result = await provider.verify(token);
        if (!result.ok) throw new Error('expected ok');
        expect(result.user.claims?.custom).toBe('value');
        expect(result.user.claims?.sub).toBe('alice');
    });

    it('rejects tokens with missing sub claim', async () => {
        const provider = jwt({ publicKey: publicJwk });
        const noSub = await signToken({ email: 'x@y.com' });
        const result = await provider.verify(noSub);
        expect(result.ok).toBe(false);
    });
});
```

- [ ] **Step 2: Run — verify failure**

- [ ] **Step 3: Implement**

`packages/server/src/auth/jwt-adapter.ts`:

```typescript
import {
    jwtVerify,
    createRemoteJWKSet,
    type JWK,
    type KeyLike,
    type JWTVerifyGetKey,
    importJWK,
} from 'jose';
import type { AuthProvider, AuthVerifyResult } from '@syncengine/core';

export interface JwtAdapterOptions {
    /** URL of the issuer's JWKS endpoint. Use this for providers that
     *  rotate keys (Clerk, Auth0, most OIDC IdPs). The adapter caches
     *  the keys across verifications. */
    readonly jwksUri?: string;
    /** Static public key (JWK or PEM-as-KeyLike). Use this for custom
     *  setups where the signing key doesn't rotate. Mutually exclusive
     *  with jwksUri. */
    readonly publicKey?: JWK | KeyLike;
    /** Optional issuer enforcement. When set, tokens whose `iss` claim
     *  doesn't match are rejected. */
    readonly issuer?: string;
    /** Optional audience enforcement. When set, tokens whose `aud`
     *  claim doesn't include this value are rejected. */
    readonly audience?: string;
}

/**
 * Generic JWT auth adapter. Verifies RS256 / ES256 tokens against a
 * JWKS endpoint or a static public key.
 *
 * Produces `AuthUser.id` from the `sub` claim, `AuthUser.email` from
 * `email`, and exposes the full payload as `AuthUser.claims`. Workspace
 * roles come from the server's `resolveAuth` + `workspace.isMember`
 * enrichment, not from JWT claims.
 */
export function jwt(options: JwtAdapterOptions): AuthProvider {
    if (!options.jwksUri && !options.publicKey) {
        throw new Error('jwt(): must provide either jwksUri or publicKey');
    }

    let getKey: JWTVerifyGetKey | KeyLike | Uint8Array;
    if (options.jwksUri) {
        getKey = createRemoteJWKSet(new URL(options.jwksUri));
    } else {
        // Lazy — importJWK is async. We resolve on first verify.
        getKey = null as unknown as KeyLike;
    }

    return {
        name: 'jwt',
        verify: async (token): Promise<AuthVerifyResult> => {
            try {
                if (!getKey && options.publicKey) {
                    // Static JWK — import once, then cache.
                    getKey = 'kty' in (options.publicKey as JWK)
                        ? await importJWK(options.publicKey as JWK)
                        : (options.publicKey as KeyLike);
                }
                const verifyOptions: Record<string, unknown> = {};
                if (options.issuer) verifyOptions['issuer'] = options.issuer;
                if (options.audience) verifyOptions['audience'] = options.audience;

                const { payload } = await jwtVerify(
                    token,
                    getKey as JWTVerifyGetKey | KeyLike,
                    verifyOptions,
                );

                const sub = payload.sub;
                if (typeof sub !== 'string' || sub.length === 0) {
                    return { ok: false, reason: 'missing sub claim' };
                }

                const email = typeof payload['email'] === 'string' ? payload['email'] as string : undefined;

                return {
                    ok: true,
                    user: {
                        id: sub,
                        ...(email ? { email } : {}),
                        claims: payload as Record<string, unknown>,
                    },
                };
            } catch (err) {
                const reason = err instanceof Error ? err.message : 'verification failed';
                return { ok: false, reason };
            }
        },
    };
}
```

- [ ] **Step 4: Run — verify pass**

- [ ] **Step 5: Re-export + commit**

```typescript
// packages/server/src/index.ts
export { jwt } from './auth/jwt-adapter.js';
export type { JwtAdapterOptions } from './auth/jwt-adapter.js';
```

```bash
git add packages/server/src/auth/jwt-adapter.ts packages/server/src/__tests__/auth/jwt-adapter.test.ts packages/server/src/index.ts
git commit -m "feat(server): jwt() adapter — JWKS + static public-key verification via jose"
```

---

## Task 3: `clerk()` adapter — Clerk-tuned preset

**Files:**
- Create: `packages/server/src/auth/clerk-adapter.ts`
- Create: `packages/server/src/__tests__/auth/clerk-adapter.test.ts`

- [ ] **Step 1: Implement**

`packages/server/src/auth/clerk-adapter.ts`:

```typescript
import type { AuthProvider } from '@syncengine/core';
import { jwt } from './jwt-adapter.js';

export interface ClerkAdapterOptions {
    /** Your Clerk publishable key's issuer URL, e.g.
     *  'https://clerk.example.app' (omits the trailing `/`).
     *  Found in the Clerk dashboard under API Keys → Advanced → JWKS. */
    readonly issuer: string;
    /** Optional audience — set to your API identifier if using Clerk's
     *  template-based JWTs. */
    readonly audience?: string;
}

/**
 * Clerk auth adapter. Thin preset over `jwt()` that points at Clerk's
 * JWKS endpoint (derived from the issuer URL per Clerk's convention).
 *
 * For the client side, see the auth guide — apps use @clerk/clerk-react
 * and write a ~10-line AuthClient wrapper.
 */
export function clerk(options: ClerkAdapterOptions): AuthProvider {
    const issuer = options.issuer.replace(/\/$/, '');
    const inner = jwt({
        jwksUri: `${issuer}/.well-known/jwks.json`,
        issuer,
        ...(options.audience ? { audience: options.audience } : {}),
    });
    return {
        ...inner,
        name: 'clerk',
    };
}
```

- [ ] **Step 2: Write a test that verifies the adapter is wired to jwt()**

```typescript
import { describe, it, expect } from 'vitest';
import { clerk } from '../../auth/clerk-adapter';

describe('clerk() adapter', () => {
    it('has name "clerk"', () => {
        const provider = clerk({ issuer: 'https://example.clerk.app' });
        expect(provider.name).toBe('clerk');
    });

    it('strips trailing slash from the issuer URL', () => {
        const provider = clerk({ issuer: 'https://example.clerk.app/' });
        expect(provider.name).toBe('clerk');
    });

    // Full E2E verification (JWKS fetch + RS256 verify) is covered by the
    // jwt-adapter tests — this adapter is a 5-line preset.
});
```

- [ ] **Step 3: Re-export + commit**

```typescript
export { clerk } from './auth/clerk-adapter.js';
```

```bash
git add packages/server/src/auth/clerk-adapter.ts packages/server/src/__tests__/auth/clerk-adapter.test.ts packages/server/src/index.ts
git commit -m "feat(server): clerk() auth adapter — Clerk-tuned preset over jwt()"
```

---

## Task 4: `docs/guides/auth.md` — developer guide

**Files:**
- Create: `docs/guides/auth.md`

- [ ] **Step 1: Write the guide**

Cover:
1. The three-layer model (workspace, channel, entity) — quick recap
2. Server-side wiring (`syncengine.config.ts` with `auth.provider`)
3. `Access` DSL cheat sheet
4. `$user` placeholder
5. Channel policies
6. Client-side `StoreProvider auth={...}` + `useUser()` + `useAuthError()`
7. Worked Clerk example (both sides)
8. Known limitations (lookupRole stub, etc.)

- [ ] **Step 2: Commit**

```bash
git add docs/guides/auth.md
git commit -m "docs(auth): developer guide covering server + client integration"
```

---

## Task 5: Full workspace verification

- [ ] Build: `pnpm -w build`
- [ ] Tests: `pnpm -r --if-present test -- --run`
- [ ] Typecheck: `pnpm -r --if-present typecheck`

---

## Definition of Done

- `jwt()` adapter verifies RS256 / ES256 tokens via JWKS or static public key
- Issuer + audience enforcement supported
- `clerk()` preset over `jwt()` for the common OIDC case
- Full workspace build + tests pass
- `docs/guides/auth.md` covers end-to-end integration

## What This Closes

Plans 1-6 together deliver the full auth spec from `docs/superpowers/specs/2026-04-21-auth-design.md`:

| Plan | Delivery |
|------|----------|
| 1 | Foundation — types + Access DSL + `$user` placeholder |
| 2 | Entity enforcement — `access` block + `applyHandler` |
| 3 | Connection auth — `AuthProvider` port + `resolveAuth` + server wiring |
| 4 | Channel access — gateway `AuthHook` + subscription enforcement |
| 5 | Client SDK — `AuthState` + `useUser` + `useAuthError` + `StoreProvider` wiring |
| **6** | **Provider adapters — `jwt()` generic + `clerk()` preset + guide** |

Remaining known gaps (tracked separately):
- Gateway-side workspace role lookup in `serve.ts` (Plan 4 stub — `Access.role(...)` at channel subscribe returns empty roles until this lands)
- Additional native adapters (Auth0, Descope, Supabase) — community extensions against the `AuthProvider` contract
