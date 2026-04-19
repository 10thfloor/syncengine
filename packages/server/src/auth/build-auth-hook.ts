// Compose the gateway AuthHook from the server-side auth surface:
//   - verifyInit  → resolveAuth against the configured AuthProvider
//   - authorizeChannel → evaluate the channel's $access policy from the registry
//
// Kept separate from the gateway construction site so tests can build a
// hook without spinning up a WebSocket server.

import type { AuthProvider, AuthUser } from '@syncengine/core';
import type { AuthHook } from '@syncengine/gateway-core';
import { resolveAuth } from './resolve-auth.js';
import { getChannelAccess } from './channel-registry.js';

/**
 * Build an `AuthHook` for `GatewayCore` from the server-side auth
 * configuration.
 *
 * `lookupRole` is injected rather than baked in because the caller
 * controls how the workspace-role lookup happens outside a Restate
 * context — the gateway runs in a plain node process.
 */
export function buildAuthHook(opts: {
    provider: AuthProvider | undefined;
    lookupRole: (userId: string, workspaceId: string) => Promise<string | null>;
    /** When true, non-members are rejected at WebSocket init — gateway
     *  sends UNAUTHORIZED and closes the socket. Wired from
     *  `auth.requireWorkspaceMembership` in SyncengineConfig. */
    requireMembership?: boolean;
}): AuthHook {
    return {
        verifyInit: (authToken: string | undefined, workspaceId: string): Promise<AuthUser | null> =>
            resolveAuth({
                provider: opts.provider,
                authHeader: authToken ? `Bearer ${authToken}` : undefined,
                workspaceId,
                lookupRole: opts.lookupRole,
                ...(opts.requireMembership ? { requireMembership: true } : {}),
            }),
        authorizeChannel: async (user, _workspaceId, channelName) => {
            const policy = getChannelAccess(channelName);
            if (!policy) return true; // no policy = public (within workspace)
            return policy.check({
                user,
                key: channelName,
            });
        },
    };
}
