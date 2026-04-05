/**
 * Protocol/contract types shared between the client runtime, the worker,
 * and server-side code. Pure types — no runtime, no React, no workers.
 *
 * These used to live in store.ts, but they describe the *wire protocol*
 * between layers, not the React store. Moving them to core lets both
 * packages/core (channels.ts) and packages/client (store.ts) share them
 * without a circular dependency.
 */

import type { ChannelConfig } from './channels';

// ── Sync configuration ─────────────────────────────────────────────────────

export interface SyncConfig {
    workspaceId: string;
    /** default: ws://localhost:9222 */
    natsUrl?: string;
    /** default: http://localhost:8080 */
    restateUrl?: string;
    /** JWT for NATS + Restate auth */
    authToken?: string;
    /** User identity for message attribution */
    userId?: string;
    /**
     * Optional multi-channel sync. Each channel maps a subset of tables to
     * its own NATS subject so access can be enforced per-channel via NATS
     * subject ACLs. If omitted, all tables sync through the single default
     * `ws.{workspaceId}.deltas` subject.
     */
    channels?: ChannelConfig[];
}

// ── Connection / sync status ───────────────────────────────────────────────

export type ConnectionStatus =
    | 'off'
    | 'connecting'
    | 'syncing'
    | 'connected'
    | 'disconnected'
    | 'auth_failed';

export interface SyncStatus {
    phase: 'idle' | 'replaying' | 'live';
    messagesReplayed: number;
    totalMessages?: number;
    snapshotLoaded: boolean;
}

// ── Conflict record (per-field LWW resolution result) ─────────────────────

export interface ConflictRecord {
    table: string;
    recordId: string;
    field: string;
    winner: { value: unknown; hlc?: number; userId?: string };
    loser: { value: unknown; hlc?: number; userId?: string };
    strategy: string;
    resolvedAt: number;
    dismissed: boolean;
}
