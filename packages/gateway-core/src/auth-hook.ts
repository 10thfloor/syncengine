/**
 * Gateway auth injection point.
 *
 * gateway-core lives in its own package and intentionally does NOT depend
 * on `@syncengine/server`. Real token verification (JWT, OIDC, etc.) and
 * the channel registry live there. This file declares the callback shape
 * the host wires at `GatewayCore` construction.
 *
 * Pre-auth apps pass no hook — gateway-core uses a pass-through default
 * that accepts every token as anonymous and every subscription as allowed.
 */

import type { AuthUser } from '@syncengine/core';

/**
 * Verify an init-time auth token. Returns the verified user (with
 * per-workspace roles populated) or `null` for unauthenticated callers.
 *
 * Called once per WebSocket on the `init` frame. If the token is
 * present but rejected, the gateway closes the WS with `UNAUTHORIZED`.
 * A null return WITHOUT a token means "unauthenticated" (Access.public
 * channels still work); a null return WITH a token means "rejected".
 */
export type VerifyInitFn = (
    authToken: string | undefined,
    workspaceId: string,
) => Promise<AuthUser | null>;

/**
 * Check whether the verified user may subscribe to the named channel.
 * Called inside `attach()` before any consumer is spun up. Returning
 * `false` triggers an `ACCESS_DENIED` error frame to the client and
 * skips the subscription.
 *
 * The host reads the channel's `$access` policy from its registry and
 * evaluates it — gateway-core doesn't know what channels exist.
 */
export type AuthorizeChannelFn = (
    user: AuthUser | null,
    workspaceId: string,
    channelName: string,
) => Promise<boolean>;

export interface AuthHook {
    readonly verifyInit: VerifyInitFn;
    readonly authorizeChannel: AuthorizeChannelFn;
}

/** Pass-through hook used when the host declares no auth. Matches
 *  pre-Plan-4 behavior: tokens aren't verified and every channel is
 *  allowed. Apps that never set `auth.provider` in their config never
 *  leave this mode. */
export const PASSTHROUGH_AUTH_HOOK: AuthHook = {
    verifyInit: async () => null,
    authorizeChannel: async () => true,
};
