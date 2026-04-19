/**
 * Auth provider port — the adapter contract between Hexo and an external
 * identity system (Clerk, Auth0, custom JWT, in-memory dev stub).
 *
 * The framework owns authorization (Access DSL, policies). Providers own
 * authentication — verifying the bearer token and returning the user id +
 * claims. Workspace role lookup is separate — see server/auth/resolve-auth.
 */
import type { AuthUser } from './auth';

/**
 * Result of a provider's token verification. Discriminated union on `ok`:
 *   - `{ ok: true, user }`   — token valid, user identity extracted
 *   - `{ ok: false, reason }` — token rejected (expired, bad signature, etc.)
 *
 * The verified user has no `roles` — those come from the workspace
 * membership lookup, not from the JWT.
 */
export type AuthVerifyResult =
    | { readonly ok: true; readonly user: Omit<AuthUser, 'roles'> }
    | { readonly ok: false; readonly reason: string };

export interface AuthProvider {
    /** Adapter name — surfaced in logs and error messages. */
    readonly name: string;
    /** Verify a bearer token. Return the user (without roles — server
     *  enriches from workspace membership) or a reason on rejection. */
    verify(token: string): Promise<AuthVerifyResult>;
    /** Optional: refresh an expired token. Returns a new token string
     *  or `null` if refresh is not supported / the session is dead. */
    refresh?(token: string): Promise<string | null>;
}
