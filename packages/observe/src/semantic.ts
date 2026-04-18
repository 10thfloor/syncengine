// Closed attribute namespace for every syncengine-emitted OTel signal.
//
// Every seam helper in `internal.ts` and the ctx factory tag spans and
// metrics through these constants — no string literals at call sites.
// That keeps the set greppable, prevents typo drift, and makes changing
// a key a single-file edit.

export const ATTR_WORKSPACE = 'syncengine.workspace' as const;
export const ATTR_USER = 'syncengine.user' as const;
export const ATTR_PRIMITIVE = 'syncengine.primitive' as const;
export const ATTR_NAME = 'syncengine.name' as const;
export const ATTR_OP = 'syncengine.op' as const;
export const ATTR_TOPIC = 'syncengine.topic' as const;
export const ATTR_INVOCATION = 'syncengine.invocation' as const;
export const ATTR_DEDUP_HIT = 'syncengine.dedup.hit' as const;

export type Primitive =
    | 'entity'
    | 'topic'
    | 'workflow'
    | 'webhook'
    | 'heartbeat'
    | 'gateway'
    | 'bus'
    | 'http';

/** Every key the framework may tag on a span or metric, for exhaustive types. */
export type SyncengineAttrKey =
    | typeof ATTR_WORKSPACE
    | typeof ATTR_USER
    | typeof ATTR_PRIMITIVE
    | typeof ATTR_NAME
    | typeof ATTR_OP
    | typeof ATTR_TOPIC
    | typeof ATTR_INVOCATION
    | typeof ATTR_DEDUP_HIT;
