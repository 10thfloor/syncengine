/**
 * Channel routing for multi-channel sync.
 *
 * A channel is a subset of tables that sync through a dedicated NATS subject,
 * allowing access control to be enforced at the NATS subject ACL layer. Each
 * table belongs to at most one channel; publishes route by table, subscribes
 * fan out over all channel subjects.
 *
 * Phase 2.5: `ChannelConfig.tables` now takes `Table` object references
 * instead of raw strings, so typos become compile-time errors. The channel
 * name is a generic parameter so the literal string survives through the
 * store type (used by `ChannelNames<T>` to extract the union).
 */

import type { AnyTable } from './schema';

/** A sync channel: maps a set of tables to a NATS subject. */
export interface ChannelConfig<TName extends string = string> {
    /** Channel name — used to build the NATS subject. */
    readonly name: TName;
    /** Tables whose mutations publish to this channel. */
    readonly tables: readonly AnyTable[];
}

/**
 * Group tables into a named channel. Tables in the same channel share
 * a single JetStream subject and replay together.
 *
 *     channel('realtime', [clicks, notes])
 *
 * Tables not assigned to any explicit channel get their own
 * auto-generated channel (one per table).
 */
export function channel<const TName extends string>(
    name: TName,
    tables: readonly AnyTable[],
): ChannelConfig<TName> {
    return { name, tables };
}

/**
 * Extract the union of channel names from a readonly array of
 * `ChannelConfig`s — used by `Store<T>` to type `db.channels` and by
 * nats-acl.ts to constrain role specs.
 */
export type ChannelNames<T extends readonly ChannelConfig[]> =
    T extends readonly ChannelConfig<infer N>[] ? N : never;

/**
 * Template-literal type for a channel's delta subject. Parameterized on
 * the workspace id and the channel name so downstream APIs that take a
 * subject string can be constrained to "must be a real channel subject."
 */
export type ChannelSubject<W extends string, C extends string> =
    `ws.${W}.ch.${C}.deltas`;

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
 * Minimal structural input to `buildChannelRouting`. Accepts any object with
 * a workspaceId and optional channels, including the full `SyncConfig` —
 * avoids a circular dependency between channels.ts and sync-types.ts.
 */
interface ChannelRoutingInput {
    workspaceId: string;
    channels?: readonly ChannelConfig[];
}

/**
 * Build the channel routing table from a workspace config.
 *
 * Legacy mode (no `channels` field): all tables sync through the single
 * `ws.{workspaceId}.deltas` subject. Back-compatible with single-channel
 * setups.
 *
 * Multi-channel mode: each channel maps to `ws.{workspaceId}.ch.{name}.deltas`,
 * and each table is routed to its declared channel (via `t.$name`).
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
            const tableName = t.$name;
            if (tableToSubject[tableName]) {
                // Table double-assigned: last channel wins, but warn.
                // eslint-disable-next-line no-console
                console.warn(`[channels] table '${tableName}' mapped to multiple channels; using '${ch.name}'`);
            }
            tableToSubject[tableName] = subject;
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
