// ── Topic DSL (ephemeral pub/sub) ──────────────────────────────────────────
//
// `topic()` declares a typed ephemeral broadcast channel. Unlike `table()`
// (CRDT-replicated, JetStream-persisted) and `defineEntity()` (single-writer
// actor via Restate), topics use NATS core pub/sub with no persistence, no
// JetStream, and no Restate. Data is transient — each peer publishes its own
// state and receives other peers' state in real time.
//
// Use cases: cursors, typing indicators, drag positions, presence, live
// selections — any high-frequency ephemeral data that doesn't need to survive
// a page refresh.
//
// The API mirrors `table()`:
//
//     const cursors = topic('cursors', {
//         x: real(),
//         y: real(),
//         color: text(),
//     });
//
// On the client, `db.useTopic(cursors, 'global')` returns a reactive peer
// map and a `publish()` function.

import type { EntityStateShape, EntityState } from "./entity";
import { buildInitialState } from "./entity";
import { errors, SchemaCode } from './errors';

// ── Topic definition ──────────────────────────────────────────────────────

export interface TopicDef<
    TName extends string,
    TShape extends EntityStateShape,
> {
    readonly $tag: "topic";
    readonly $name: TName;
    readonly $state: TShape;
    readonly $initialState: EntityState<TShape>;
    /** Phantom field carrying the inferred state record type. */
    readonly $record: EntityState<TShape>;
}

/** Type-level shortcut: extract the state record type from a TopicDef. */
export type TopicRecord<T> =
    T extends TopicDef<string, infer TShape> ? EntityState<TShape> : never;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTopic = TopicDef<string, any>;

// ── topic() ───────────────────────────────────────────────────────────────

/**
 * Declare a topic type. Pass the topic's `name` (used as a NATS subject
 * token) and its state shape — the set of fields each peer publishes.
 *
 * Example:
 *
 *     const cursors = topic('cursors', {
 *         x: real(),
 *         y: real(),
 *         color: text(),
 *     });
 */
export function topic<
    const TName extends string,
    TShape extends EntityStateShape,
>(name: TName, state: TShape): TopicDef<TName, TShape> {
    if (!name || typeof name !== "string") {
        throw errors.schema(SchemaCode.INVALID_TOPIC_NAME, {
            message: `topic: name must be a non-empty string.`,
            hint: `Pass a valid name: topic('myTopic', { ... })`,
        });
    }
    if (name.startsWith("$")) {
        throw errors.schema(SchemaCode.INVALID_TOPIC_NAME, {
            message:
                `topic('${name}'): names may not start with '$' ` +
                `(reserved for framework metadata).`,
            hint: `Remove the '$' prefix.`,
            context: { topic: name },
        });
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw errors.schema(SchemaCode.INVALID_TOPIC_NAME, {
            message:
                `topic('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/ ` +
                `so it can be used as a NATS subject token.`,
            hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
            context: { topic: name },
        });
    }
    for (const fieldName of Object.keys(state)) {
        if (fieldName.startsWith("$")) {
            throw errors.schema(SchemaCode.RESERVED_COLUMN_PREFIX, {
                message:
                    `topic('${name}'): state field '${fieldName}' may not start ` +
                    `with '$' (reserved for framework metadata).`,
                hint: `Rename the field to remove the '$' prefix.`,
                context: { topic: name, field: fieldName },
            });
        }
    }

    return {
        $tag: "topic",
        $name: name,
        $state: state,
        $initialState: buildInitialState(state),
        $record: undefined as never,
    };
}

// ── Runtime helpers ──────────────────────────────────────────────────────

/** Type guard for any topic definition. */
export function isTopic(x: unknown): x is AnyTopic {
    return (
        typeof x === "object" &&
        x !== null &&
        (x as { $tag?: string }).$tag === "topic"
    );
}
