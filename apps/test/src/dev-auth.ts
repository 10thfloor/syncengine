// Dev-only AuthClient — the kitchen-sink app uses `?user=<id>` from the
// query string as its "authentication." The server is running the
// `unverified()` adapter (see syncengine.config.ts), which trusts the
// bearer token literally as the user id. In production, swap this for
// an adapter around Clerk / Auth0 / your auth provider SDK.

import type { AuthClient } from '@syncengine/client';
import type { AuthUser } from '@syncengine/core';

function readUserIdFromUrl(): string | null {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('user');
    return id && id.length > 0 ? id : null;
}

const listeners = new Set<() => void>();

function fire(): void {
    for (const l of listeners) l();
}

// Re-read the URL whenever it changes (pushState / popstate). React
// Router etc. already trigger this; pure `?user=` swaps also work.
if (typeof window !== 'undefined') {
    window.addEventListener('popstate', fire);
}

export const devAuth: AuthClient = {
    getUser: (): AuthUser | null => {
        const id = readUserIdFromUrl();
        return id ? { id, roles: [] } : null;
    },
    subscribe: (cb) => {
        listeners.add(cb);
        return () => {
            listeners.delete(cb);
        };
    },
    // The bearer token IS the user id — matches the unverified() adapter
    // on the server, which uses the token verbatim as AuthUser.id.
    getToken: () => readUserIdFromUrl(),
};
