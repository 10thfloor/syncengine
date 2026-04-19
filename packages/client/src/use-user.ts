import { useSyncExternalStore } from 'react';
import type { AuthUser } from '@syncengine/core';
import { authState, type AuthError } from './auth-state';

export interface UseUserResult {
    readonly user: AuthUser | null;
    readonly isAuthenticated: boolean;
}

/**
 * Reactive access to the current authenticated user.
 *
 * Returns `null` until the host app has installed an `AuthClient` on
 * `<StoreProvider auth={...} />` that yields a verified identity.
 *
 *     function Header() {
 *         const { user, isAuthenticated } = useUser();
 *         if (!isAuthenticated) return <SignInButton />;
 *         return <Avatar email={user!.email} />;
 *     }
 */
export function useUser(): UseUserResult {
    const user = useSyncExternalStore(
        (cb) => authState.subscribe(cb),
        () => authState.getUser(),
        () => null, // SSR — no user during server render
    );
    return {
        user,
        isAuthenticated: user !== null,
    };
}

/**
 * Reactive access to the latest auth-layer error from the gateway —
 * UNAUTHORIZED at init rejection, ACCESS_DENIED on a denied channel
 * subscribe. Returns `null` when there is no current error.
 *
 *     function AccessBanner() {
 *         const error = useAuthError();
 *         if (!error) return null;
 *         return <Toast>{error.message}</Toast>;
 *     }
 *
 * The error clears only when the host explicitly calls
 * `authState.setError(null)` — so the UI is free to leave it on screen
 * until dismissed.
 */
export function useAuthError(): AuthError | null {
    return useSyncExternalStore(
        (cb) => authState.subscribe(cb),
        () => authState.getError(),
        () => null,
    );
}
