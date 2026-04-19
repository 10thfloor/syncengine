import type { AuthProvider, AuthVerifyResult } from '@syncengine/core';

/**
 * Custom auth adapter — the caller supplies the verify function (and
 * optionally a refresh function). Use this when you have an existing
 * JWT library, a custom session store, or any verification strategy
 * that doesn't fit a standard OIDC flow.
 *
 * For OIDC providers (Clerk, Auth0, Descope), Plan 6 ships dedicated
 * adapters that wrap their SDKs.
 */
export function custom(opts: {
    verify: (token: string) => Promise<AuthVerifyResult>;
    refresh?: (token: string) => Promise<string | null>;
}): AuthProvider {
    const provider: AuthProvider = {
        name: 'custom',
        verify: opts.verify,
    };
    if (opts.refresh) {
        (provider as { refresh?: typeof opts.refresh }).refresh = opts.refresh;
    }
    return provider;
}
