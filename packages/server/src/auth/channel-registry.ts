// Module-level channel registry — populated at boot by `registerChannels`.
// The gateway's AuthHook looks up each channel's $access policy here when
// authorizing subscribe requests. null = no policy = public (within the
// workspace). Pre-auth apps skip registration entirely and every channel
// stays public.

import type { ChannelConfig, AccessPolicy } from '@syncengine/core';

let _channels: readonly ChannelConfig[] = [];

/** Install the full channel list. Called once at boot by the server
 *  after config loading. Replaces any previously-registered channels —
 *  idempotent per process. */
export function registerChannels(channels: readonly ChannelConfig[]): void {
    _channels = channels;
}

/** Look up a channel's access policy by name. Returns null for:
 *   - channels not found in the registry (pre-auth apps — no policy)
 *   - channels explicitly declared without an $access field */
export function getChannelAccess(name: string): AccessPolicy | null {
    const ch = _channels.find((c) => c.name === name);
    return ch?.$access ?? null;
}

/** Test-only — reset the registry between tests. */
export function __resetChannelRegistry(): void {
    _channels = [];
}
