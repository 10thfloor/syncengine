import type { AuthUser } from '@syncengine/core';

/** Auth-layer error surfaced from the gateway.
 *    - UNAUTHORIZED — init rejected (bad token, not a workspace member
 *      when requireWorkspaceMembership is on)
 *    - ACCESS_DENIED — channel subscribe rejected by the channel's
 *      $access policy
 *    - WORKSPACE_ACCESS_REVOKED — membership was revoked while the
 *      session was open; the server broadcast the event and the client
 *      should prompt the user to re-authenticate or navigate away.
 *
 *  Distinct from per-action errors, which surface on the individual
 *  entity/view hook. */
export interface AuthError {
    readonly code: 'UNAUTHORIZED' | 'ACCESS_DENIED' | 'WORKSPACE_ACCESS_REVOKED';
    readonly message: string;
    /** Channel name when code === 'ACCESS_DENIED' on a subscribe. */
    readonly channel?: string;
}

/**
 * Client-side auth state. A subscribable slot for the current user and
 * their bearer token. Host apps provide updates via a thin AuthClient
 * abstraction (passed to `<StoreProvider auth={...} />`) or by calling
 * `setUser` / `setToken` directly (for custom auth flows).
 *
 * `useUser()` subscribes here; entity-client's setCurrentUserGetter
 * reads `getUser()` on every optimistic handler call so policies see
 * reactive user changes without a React rerender.
 */
export class AuthState {
    private user: AuthUser | null = null;
    private token: string | null = null;
    private error: AuthError | null = null;
    private readonly listeners = new Set<() => void>();

    getUser(): AuthUser | null {
        return this.user;
    }

    getToken(): string | null {
        return this.token;
    }

    getError(): AuthError | null {
        return this.error;
    }

    setUser(user: AuthUser | null): void {
        if (user === this.user) return;
        this.user = user;
        this.notify();
    }

    setToken(token: string | null): void {
        if (token === this.token) return;
        this.token = token;
        this.notify();
    }

    /** Set or clear the latest auth error. Clears on every call so the
     *  UI can dismiss by calling `setError(null)`. */
    setError(error: AuthError | null): void {
        if (error === this.error) return;
        this.error = error;
        this.notify();
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private notify(): void {
        for (const l of this.listeners) l();
    }
}

/**
 * Shared process-level AuthState. `StoreProvider` installs the host's
 * AuthClient against this instance. entity-client reads from it.
 */
export const authState = new AuthState();
