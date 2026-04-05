/**
 * Pure NATS permission generator.
 *
 * Given a role's read/write channel lists and a workspace id, produces the
 * NATS subject allow-lists that a JWT would embed. Phase 2.5 ships only
 * the pure helper + types — no caller yet. Phase 8 wires it into the
 * workspace service's `mintToken` handler alongside the typed-roles
 * user-facing config.
 *
 * The generator is deliberately decoupled from the client config shape:
 * it takes just the values it needs (workspaceId, role spec), so it can
 * be called from either the client (for local preview / debugging) or
 * the server (for authoritative token minting) without dragging in
 * store-shaped types.
 */

import type { ChannelNames, ChannelConfig } from './channels';

// ── Types ─────────────────────────────────────────────────────────────────

/** A role's read/write access lists, keyed by channel name. */
export interface RoleSpec<TChannel extends string = string> {
    readonly read: readonly TChannel[];
    readonly write: readonly TChannel[];
}

/** A record of roles keyed by role name, each constrained to the
 *  channel-name union of the given channel config. */
export type Roles<
    TChannels extends readonly ChannelConfig[],
    TRoleNames extends string = string,
> = {
    readonly [R in TRoleNames]: RoleSpec<ChannelNames<TChannels>>;
};

/** NATS permission object — publish + subscribe allow/deny lists. */
export interface NatsPermissions {
    publish: { allow: string[]; deny: string[] };
    subscribe: { allow: string[]; deny: string[] };
}

// ── Helper ────────────────────────────────────────────────────────────────

/**
 * Compute the NATS permission object for a role, given a workspace id
 * and a role spec. Pure — no I/O, no config lookup, no side effects.
 *
 * The returned allow-lists contain the fully-qualified subject strings
 * for each channel the role can read or write
 * (`ws.{workspaceId}.ch.{channelName}.deltas`). Deny-lists are empty
 * by convention — NATS ACLs are allow-list by default.
 */
export function generateNatsPermissions(
    workspaceId: string,
    role: RoleSpec,
): NatsPermissions {
    const subject = (ch: string) => `ws.${workspaceId}.ch.${ch}.deltas`;
    return {
        publish: {
            allow: role.write.map(subject),
            deny: [],
        },
        subscribe: {
            allow: role.read.map(subject),
            deny: [],
        },
    };
}
