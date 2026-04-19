import type { AuthUser } from '@syncengine/core';

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
    private readonly listeners = new Set<() => void>();

    getUser(): AuthUser | null {
        return this.user;
    }

    getToken(): string | null {
        return this.token;
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
