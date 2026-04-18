/**
 * `on(bus)` — fluent subscription builder used on the subscriber
 * side of a `defineWorkflow({ on, services })` declaration.
 *
 * Modifiers in the ordering family share a single runtime mechanism:
 * they all influence how the dispatcher derives Restate's invocation
 * id from an incoming event. Restate's single-writer-per-key gives us
 * serialisation for free, so:
 *
 *   - default               → invocationId = `${busName}:${seq}`   (parallel, exactly-once per msg)
 *   - .ordered()            → invocationId = `${busName}:singleton` (global single-writer per subscriber)
 *   - .orderedBy(fn)        → invocationId = `${busName}:${fn(e)}`  (single-writer per key, keys parallel)
 *   - .key(fn)              → invocationId = fn(e)                  (user owns the full id; no prefix)
 *
 * The returned `Subscription<T>` is a plain value — no class —
 * so it serialises through build-time manifests without loss.
 */

import type { BusRef } from '@syncengine/core';

export type CursorConfig =
    | { readonly kind: 'beginning' }
    | { readonly kind: 'latest' }
    | { readonly kind: 'sequence'; readonly seq: number }
    | { readonly kind: 'time'; readonly at: string };

/** Typed factory namespace for durable-consumer cursors.
 *  `From.beginning()` / `.latest()` / `.sequence(n)` / `.time(d)` —
 *  no magic strings passed to `.from(...)`. */
export const From = {
    beginning: (): CursorConfig => ({ kind: 'beginning' }),
    latest: (): CursorConfig => ({ kind: 'latest' }),
    sequence: (seq: number): CursorConfig => {
        if (!Number.isInteger(seq) || seq < 0) {
            throw new Error(`From.sequence: seq must be a non-negative integer (got ${seq})`);
        }
        return { kind: 'sequence', seq };
    },
    time: (at: Date | string): CursorConfig => ({
        kind: 'time',
        at: typeof at === 'string' ? at : at.toISOString(),
    }),
};

/**
 * How the dispatcher should derive Restate's invocation id from an
 * incoming event. Exactly one of these wins per subscription; they're
 * mutually exclusive in the builder.
 *
 *   - `'perMessage'` is the default: one invocation per JetStream seq.
 *     Gives exactly-once processing, no ordering, full parallelism.
 *   - `'singleton'` collapses all messages into a single invocation id
 *     (`.ordered()`) — serialised delivery, redeliveries idempotent.
 *   - `'byKey'` picks a key from the event; one invocation per key, keys
 *     parallel (`.orderedBy(fn)`).
 *   - `'custom'` lets the user own the full invocation id without any
 *     framework prefix (`.key(fn)`).
 */
export type InvocationKeying<T> =
    | { readonly kind: 'perMessage' }
    | { readonly kind: 'singleton' }
    | { readonly kind: 'byKey'; readonly fn: (event: T) => string }
    | { readonly kind: 'custom'; readonly fn: (event: T) => string };

export interface Subscription<T> {
    readonly $tag: 'bus-subscription';
    readonly bus: BusRef<T>;
    readonly predicate?: (event: T) => boolean;
    readonly cursor?: CursorConfig;
    /** Ordering / dedup mode. Defaults to `{ kind: 'perMessage' }` when
     *  none of `.ordered` / `.orderedBy` / `.key` is used. */
    readonly keying?: InvocationKeying<T>;
    where(predicate: (event: T) => boolean): Subscription<T>;
    from(cursor: CursorConfig): Subscription<T>;
    /** Single in-flight invocation for this subscriber. Redeliveries
     *  collapse into the one invocation; Restate's workflow
     *  idempotency takes over. */
    ordered(): Subscription<T>;
    /** One in-flight invocation per `fn(event)` value. Events that
     *  map to the same key serialise; distinct keys run in parallel. */
    orderedBy(fn: (event: T) => string): Subscription<T>;
    /** User-defined invocation id. Skips the framework's
     *  `${busName}:` prefix — caller owns uniqueness. Useful when the
     *  same logical event enters through multiple buses and you want
     *  a single dedup barrier. */
    key(fn: (event: T) => string): Subscription<T>;
}

function validateKeyFn(fn: unknown, method: string): void {
    if (typeof fn !== 'function') {
        throw new Error(`on().${method}(fn): expected a function, got ${typeof fn}`);
    }
}

export function on<T>(busRef: BusRef<T>): Subscription<T> {
    const build = (
        predicate?: Subscription<T>['predicate'],
        cursor?: CursorConfig,
        keying?: InvocationKeying<T>,
    ): Subscription<T> => ({
        $tag: 'bus-subscription',
        bus: busRef,
        ...(predicate ? { predicate } : {}),
        ...(cursor ? { cursor } : {}),
        ...(keying ? { keying } : {}),
        where: (p) => build(p, cursor, keying),
        from: (c) => build(predicate, c, keying),
        ordered: () => build(predicate, cursor, { kind: 'singleton' }),
        orderedBy: (fn) => {
            validateKeyFn(fn, 'orderedBy');
            return build(predicate, cursor, { kind: 'byKey', fn });
        },
        key: (fn) => {
            validateKeyFn(fn, 'key');
            return build(predicate, cursor, { kind: 'custom', fn });
        },
    });
    return build();
}

export function isSubscription(value: unknown): value is Subscription<unknown> {
    return (
        !!value &&
        typeof value === 'object' &&
        (value as { $tag?: unknown }).$tag === 'bus-subscription'
    );
}

/** Pure derivation — used by BusManager to materialise the dispatcher's
 *  invocation-id function from a `Subscription<T>`. Exposed here so the
 *  dispatcher and unit tests share exactly one implementation. */
export function deriveInvocationId<T>(
    busName: string,
    seq: bigint | number,
    event: T,
    keying: InvocationKeying<T> | undefined,
): string {
    const k: InvocationKeying<T> = keying ?? { kind: 'perMessage' };
    switch (k.kind) {
        case 'perMessage':
            return `${busName}:${typeof seq === 'bigint' ? seq.toString() : seq}`;
        case 'singleton':
            return `${busName}:singleton`;
        case 'byKey':
            return `${busName}:${k.fn(event)}`;
        case 'custom':
            return k.fn(event);
    }
}
