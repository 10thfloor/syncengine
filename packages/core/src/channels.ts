/**
 * Channel routing for multi-channel sync.
 *
 * A channel is a subset of tables that sync through a dedicated NATS subject,
 * allowing access control to be enforced at the NATS subject ACL layer. Each
 * table belongs to at most one channel; publishes route by table, subscribes
 * fan out over all channel subjects.
 *
 * This module is deliberately pure and shared between the TypeScript store
 * and the JavaScript worker — no NATS, no SQLite, no DBSP — so it can be
 * unit-tested in isolation and imported from either side.
 */

/** A sync channel: maps a set of tables to a NATS subject. */
export interface ChannelConfig {
    /** Channel name — used to build the NATS subject. */
    name: string;
    /** Tables whose mutations publish to this channel. */
    tables: string[];
}

/**
 * Minimal structural input to `buildChannelRouting`. Accepts any object with
 * a workspaceId and optional channels, including the full `SyncConfig` —
 * avoids a circular dependency between channels.ts and sync-types.ts.
 */
interface ChannelRoutingInput {
    workspaceId: string;
    channels?: ChannelConfig[];
}

/** Precomputed channel routing state used by the worker. */
export interface ChannelRouting {
    /** All delta subjects this store subscribes to (in declared channel order). */
    subjects: string[];
    /** table name → delta subject. Tables absent here are not synced. */
    tableToSubject: Record<string, string>;
}

/** Minimal shape of a message that can be routed. */
export interface RoutableMessage {
    type: string;
    table?: string;
}

/**
 * Build the channel routing table from a SyncConfig.
 *
 * Legacy mode (no `channels` field): all tables sync through the single
 * `ws.{workspaceId}.deltas` subject. Back-compatible with the original setup.
 *
 * Multi-channel mode: each channel maps to `ws.{workspaceId}.ch.{name}.deltas`,
 * and each table is routed to its declared channel.
 */
export function buildChannelRouting(
    sync: ChannelRoutingInput,
    allTableNames: string[],
): ChannelRouting {
    const workspaceId = sync.workspaceId;

    if (!sync.channels || sync.channels.length === 0) {
        const subject = `ws.${workspaceId}.deltas`;
        const tableToSubject: Record<string, string> = {};
        for (const t of allTableNames) tableToSubject[t] = subject;
        return { subjects: [subject], tableToSubject };
    }

    const subjects: string[] = [];
    const tableToSubject: Record<string, string> = {};

    for (const ch of sync.channels) {
        const subject = `ws.${workspaceId}.ch.${ch.name}.deltas`;
        subjects.push(subject);
        for (const t of ch.tables) {
            if (tableToSubject[t]) {
                // Table double-assigned: last channel wins, but warn.
                // eslint-disable-next-line no-console
                console.warn(`[channels] table '${t}' mapped to multiple channels; using '${ch.name}'`);
            }
            tableToSubject[t] = subject;
        }
    }

    return { subjects, tableToSubject };
}

/**
 * Resolve which subjects a message should be published to.
 *
 * - Table-scoped messages (INSERT, DELETE with `table` set) go to that table's channel.
 * - Workspace-wide messages (RESET without `table`) fan out to every channel.
 * - Messages for unmapped tables silently drop (caller may log).
 */
export function resolvePublishSubjects(
    routing: ChannelRouting,
    msg: RoutableMessage,
): string[] {
    if (msg.table) {
        const subject = routing.tableToSubject[msg.table];
        return subject ? [subject] : [];
    }
    return [...routing.subjects];
}
