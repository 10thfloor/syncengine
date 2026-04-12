// ── Heartbeat registry ──────────────────────────────────────────────────────
//
// Module-level registry of heartbeat definitions, populated at endpoint
// startup by `startRestateEndpoint`. The workspace service reads it
// during `provision` to invoke `trigger: 'boot'` heartbeats for the
// newly-active wsKey.
//
// Single-process scope is intentional — each server replica loads the
// same set of definitions from the same source tree, so a module-level
// registry is consistent across replicas. Cluster-wide coordination
// still happens through Restate (workflow-per-key dedup).

import type { HeartbeatDef } from './heartbeat.js';

let registered: readonly HeartbeatDef[] = [];

export function registerHeartbeats(defs: readonly HeartbeatDef[]): void {
    registered = defs;
}

export function getRegisteredHeartbeats(): readonly HeartbeatDef[] {
    return registered;
}
