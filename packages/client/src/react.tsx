/**
 * React context for the syncengine store.
 *
 * Usage:
 *
 *     // main.tsx
 *     const db = store({ tables, views, ... });
 *     <StoreProvider store={db}>
 *         <App />
 *     </StoreProvider>
 *
 *     // Any component, any depth:
 *     const db = useStore<typeof db>();
 *     const { views, ready } = db.use({ topExpenses });
 *
 * The context-provided store is identical to a module-level constant;
 * both patterns work. The provider is the recommended pattern because
 * it lets tests mount components against a mock store without rewiring
 * imports.
 */

import { createContext, useContext, useEffect, type ReactNode, type ReactElement } from 'react';
import { errors, CliCode, type AuthUser } from '@syncengine/core';
import type { Store } from './store';
import { authState } from './auth-state';

type AnyStore = Store<any, any>;

const StoreContext = createContext<AnyStore | null>(null);

/**
 * Host-provided client that gives syncengine access to the current user
 * and (optionally) a bearer token. The provider reads once at mount and
 * subscribes to updates so logins / logouts / token refreshes flow into
 * `useUser()` and the entity-client's optimistic enforcement path.
 */
export interface AuthClient {
    /** Return the current user synchronously. */
    getUser(): AuthUser | null;
    /** Subscribe to user changes — called when the host's auth state
     *  changes (login, logout, token refresh). Return an unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** Optional: return the current bearer token. Used in Plan 6 by
     *  adapters that want to rotate the token without dropping the WS. */
    getToken?(): string | null;
}

export interface StoreProviderProps {
    store: AnyStore;
    /** Optional auth client. When provided, StoreProvider pumps user +
     *  token into the shared authState so useUser() and entity-client
     *  see reactive updates. */
    auth?: AuthClient;
    children: ReactNode;
}

export function StoreProvider({ store, auth, children }: StoreProviderProps): ReactElement {
    useEffect(() => {
        if (!auth) return;
        // Initial pump — capture whatever the host has right now.
        const pump = () => {
            authState.setUser(auth.getUser());
            authState.setToken(auth.getToken?.() ?? null);
        };
        pump();
        return auth.subscribe(pump);
    }, [auth]);

    return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/**
 * Read the Store from context. Throws with a clear error if called
 * outside a `<StoreProvider>`. The generic parameter narrows the returned
 * store type to the caller's specific Store<TTables, TChannels> shape.
 */
export function useStore<T extends AnyStore = AnyStore>(): T {
    const ctx = useContext(StoreContext);
    if (!ctx) {
        throw errors.cli(CliCode.PROVIDER_MISSING, {
            message: `useStore() must be called inside a <StoreProvider store={...}>.`,
            hint: `Wrap your app:\n\n  <StoreProvider store={store}>\n    <App />\n  </StoreProvider>\n\nOr use the module-level store instance directly.`,
        });
    }
    return ctx as T;
}
