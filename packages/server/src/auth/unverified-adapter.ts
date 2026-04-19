import type { AuthProvider } from '@syncengine/core';

/**
 * Dev-only pass-through adapter. Treats the bearer token literally as
 * the user id — no signature check, no expiry, no claims. Useful for
 * local development, integration tests, and quick demos.
 *
 * Logs a loud warning at construction so production deployments that
 * accidentally ship with this adapter are caught in boot logs.
 */
export function unverified(): AuthProvider {
    console.warn(
        '[syncengine] auth: unverified() adapter is in use. Tokens are ' +
        'NOT cryptographically verified — use custom() with a real verify ' +
        'function in production.',
    );
    return {
        name: 'unverified',
        verify: async (token) => {
            if (!token) return { ok: false, reason: 'empty token' };
            return { ok: true, user: { id: token } };
        },
    };
}
