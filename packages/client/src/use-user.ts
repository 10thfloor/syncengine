import { useSyncExternalStore } from 'react';
import type { AuthUser } from '@syncengine/core';
import { authState } from './auth-state';

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
