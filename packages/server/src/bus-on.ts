/**
 * `on(bus)` — fluent subscription builder used on the subscriber
 * side of a `defineWorkflow({ on, services })` declaration.
 *
 * Phase 1 surface: `.where(predicate)` for server-side filter,
 * `.from(cursor)` for the initial consumer offset. `.ordered`,
 * `.orderedBy`, `.concurrency`, `.rate`, `.key` land in Phase 2.
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

export interface Subscription<T> {
    readonly $tag: 'bus-subscription';
    readonly bus: BusRef<T>;
    readonly predicate?: (event: T) => boolean;
    readonly cursor?: CursorConfig;
    where(predicate: (event: T) => boolean): Subscription<T>;
    from(cursor: CursorConfig): Subscription<T>;
}

export function on<T>(busRef: BusRef<T>): Subscription<T> {
    const build = (
        predicate?: Subscription<T>['predicate'],
        cursor?: CursorConfig,
    ): Subscription<T> => ({
        $tag: 'bus-subscription',
        bus: busRef,
        ...(predicate ? { predicate } : {}),
        ...(cursor ? { cursor } : {}),
        where: (p) => build(p, cursor),
        from: (c) => build(predicate, c),
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
