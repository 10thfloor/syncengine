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

import { createContext, useContext, type ReactNode, type ReactElement } from 'react';
import { errors, CliCode } from '@syncengine/core';
import type { Store } from './store';

type AnyStore = Store<any, any>;

const StoreContext = createContext<AnyStore | null>(null);

export interface StoreProviderProps {
    store: AnyStore;
    children: ReactNode;
}

export function StoreProvider({ store, children }: StoreProviderProps): ReactElement {
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
