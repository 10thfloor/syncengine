import { describe, it, expect } from 'vitest';
import type { AuthClient } from '../react';
import { authState } from '../auth-state';

// No @testing-library/react in this package, so we can't render the
// provider directly. Instead we verify the AuthClient contract
// (getUser / subscribe / optional getToken) and exercise the pump
// logic by imitating StoreProvider's effect body.

/** Mimics what StoreProvider's useEffect does at mount. */
function installAuth(auth: AuthClient): () => void {
    const pump = () => {
        authState.setUser(auth.getUser());
        authState.setToken(auth.getToken?.() ?? null);
    };
    pump();
    return auth.subscribe(pump);
}

describe('AuthClient contract', () => {
    it('pumping a static client sets user + token', () => {
        const client: AuthClient = {
            getUser: () => ({ id: 'alice', roles: ['admin'] }),
            subscribe: () => () => {},
            getToken: () => 'tok-1',
        };
        installAuth(client);
        expect(authState.getUser()?.id).toBe('alice');
        expect(authState.getToken()).toBe('tok-1');
    });

    it('subscribing propagates later user changes', () => {
        let current: { id: string } | null = { id: 'alice' };
        const listeners = new Set<() => void>();
        const client: AuthClient = {
            getUser: () => current,
            subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        };

        const unsub = installAuth(client);
        expect(authState.getUser()?.id).toBe('alice');

        // Host flips the user
        current = { id: 'bob' };
        for (const l of listeners) l();
        expect(authState.getUser()?.id).toBe('bob');

        // Host logs out
        current = null;
        for (const l of listeners) l();
        expect(authState.getUser()).toBeNull();

        unsub();
    });

    it('unsubscribing stops the pump', () => {
        let current: { id: string } | null = { id: 'alice' };
        const listeners = new Set<() => void>();
        const client: AuthClient = {
            getUser: () => current,
            subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        };

        const unsub = installAuth(client);
        unsub();

        current = { id: 'bob' };
        for (const l of listeners) l();
        // Since unsub removed the pump, authState stays at alice.
        expect(authState.getUser()?.id).toBe('alice');
    });

    it('getToken is optional', () => {
        authState.setToken(null);
        const client: AuthClient = {
            getUser: () => ({ id: 'alice' }),
            subscribe: () => () => {},
        };
        installAuth(client);
        expect(authState.getUser()?.id).toBe('alice');
        expect(authState.getToken()).toBeNull();
    });
});
