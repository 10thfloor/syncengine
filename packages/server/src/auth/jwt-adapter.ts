import {
    jwtVerify,
    createRemoteJWKSet,
    importJWK,
    type JWK,
    type KeyObject,
} from 'jose';
import type { AuthProvider, AuthVerifyResult } from '@syncengine/core';

/** Accepted signing-key shapes in jose v6: Node `KeyObject`, a raw JWK
 *  object, or a raw symmetric byte buffer. (jose also accepts web
 *  `CryptoKey` at runtime, but the server tsconfig doesn't include DOM
 *  types — if you have a CryptoKey, cast it to `KeyObject` when passing
 *  it in.) */
type VerifyKey = KeyObject | JWK | Uint8Array;

export interface JwtAdapterOptions {
    /** URL of the issuer's JWKS endpoint. Use this for providers that
     *  rotate keys (Clerk, Auth0, most OIDC IdPs). The adapter caches
     *  the keys across verifications — no per-request HTTP fetch after
     *  the first hit. */
    readonly jwksUri?: string;
    /** Static public key. Accepts a JWK object, a web CryptoKey, a Node
     *  KeyObject, or a raw Uint8Array for symmetric keys. Use for custom
     *  setups where the signing key doesn't rotate. Mutually exclusive
     *  with `jwksUri`. */
    readonly publicKey?: VerifyKey;
    /** Optional issuer enforcement. When set, tokens whose `iss` claim
     *  doesn't match are rejected. */
    readonly issuer?: string;
    /** Optional audience enforcement. When set, tokens whose `aud`
     *  claim doesn't include this value are rejected. */
    readonly audience?: string;
}

/**
 * Generic JWT auth adapter. Verifies RS256 / ES256 / EdDSA tokens
 * against a JWKS endpoint or a static public key using the `jose`
 * library.
 *
 * Produces `AuthUser.id` from the `sub` claim, `AuthUser.email` from
 * the `email` claim, and exposes the full verified payload as
 * `AuthUser.claims`. Workspace roles come from the server's
 * `resolveAuth` + `workspace.isMember` enrichment — NOT from JWT
 * claims — so roles can change at runtime (member promoted to admin)
 * without re-minting tokens.
 *
 * Example:
 *
 *     auth: {
 *         provider: jwt({
 *             jwksUri: 'https://clerk.example.app/.well-known/jwks.json',
 *             issuer: 'https://clerk.example.app',
 *         }),
 *     }
 */
export function jwt(options: JwtAdapterOptions): AuthProvider {
    if (!options.jwksUri && !options.publicKey) {
        throw new Error('jwt(): must provide either jwksUri or publicKey');
    }
    if (options.jwksUri && options.publicKey) {
        throw new Error('jwt(): jwksUri and publicKey are mutually exclusive');
    }

    // Resolved once, cached forever: either a JWKSet fetcher (remote
    // rotating keys) or a single imported key (static). `unknown` here
    // sidesteps jose's two separate overload signatures for jwtVerify
    // — both branches are valid at runtime, just hard to union in TS.
    let keyResolver: unknown = null;
    if (options.jwksUri) {
        keyResolver = createRemoteJWKSet(new URL(options.jwksUri));
    }

    return {
        name: 'jwt',
        verify: async (token): Promise<AuthVerifyResult> => {
            try {
                if (!keyResolver && options.publicKey) {
                    // Lazy import of a static JWK on first verify. Plain
                    // JWK objects have a `kty` field; already-imported
                    // KeyObject / Uint8Array don't.
                    const pk = options.publicKey;
                    keyResolver =
                        typeof pk === 'object' &&
                        pk !== null &&
                        'kty' in pk &&
                        typeof (pk as JWK).kty === 'string'
                            ? await importJWK(pk as JWK)
                            : pk;
                }

                const verifyOpts: Record<string, string> = {};
                if (options.issuer) verifyOpts['issuer'] = options.issuer;
                if (options.audience) verifyOpts['audience'] = options.audience;

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { payload } = await jwtVerify(token, keyResolver as any, verifyOpts);

                const sub = payload.sub;
                if (typeof sub !== 'string' || sub.length === 0) {
                    return { ok: false, reason: 'missing sub claim' };
                }

                const email =
                    typeof payload['email'] === 'string'
                        ? (payload['email'] as string)
                        : undefined;

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
