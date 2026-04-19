/**
 * `retryToBackoffArray` — translate a `RetryConfig` from `@syncengine/core`
 * into the JetStream consumer's `backoff` schedule and `max_deliver` count.
 *
 * Retry ownership (locked, three non-overlapping scopes):
 *   1. JetStream owns delivery-layer retry — redelivers a NAK'd message
 *      after `backoff[i]` nanoseconds, up to `max_deliver` times.
 *   2. Restate owns per-invocation idempotency via dedup on the invocation
 *      id the dispatcher derives from `<bus>:<seq>`.
 *   3. Workflow bodies own step-level retry via `ctx.run` inside the
 *      workflow handler itself.
 *
 * This helper only addresses #1. It never overlaps with #2 or #3.
 *
 * The array is one entry per _redelivery_ — JetStream consults
 * `backoff[i]` on the `i`-th NAK. `max_deliver` is `attempts + 1`
 * so the first attempt plus N redeliveries cover every slot.
 *
 * `none` → no retries, `max_deliver = 1`.
 * `fixed` → a flat array of `interval` (in nanoseconds).
 * `exponential` → doubling from `initial`, capped at `max`.
 */

import type { RetryConfig } from '@syncengine/core';

export interface BackoffSchedule {
    /** One bigint per redelivery, expressed in nanoseconds. Pass to
     *  JetStream after narrowing to `number` at the `ConsumerConfig`
     *  boundary — the upstream type is `Nanos[] = number[]` but we
     *  keep internal math in bigint to dodge precision surprises. */
    readonly backoffNs: bigint[];
    /** JetStream's `max_deliver` — first attempt plus `attempts` retries. */
    readonly maxDeliver: number;
}

const NS_PER_MS = 1_000_000n;

export function retryToBackoffArray(retry: RetryConfig): BackoffSchedule {
    switch (retry.kind) {
        case 'none':
            return { backoffNs: [], maxDeliver: 1 };
        case 'fixed': {
            const interval = BigInt(retry.interval.ms) * NS_PER_MS;
            return {
                backoffNs: Array.from({ length: retry.attempts }, () => interval),
                maxDeliver: retry.attempts + 1,
            };
        }
        case 'exponential': {
            const out: bigint[] = [];
            let delayMs = retry.initial.ms;
            const capMs = retry.max.ms;
            for (let i = 0; i < retry.attempts; i++) {
                const thisDelay = Math.min(delayMs, capMs);
                out.push(BigInt(thisDelay) * NS_PER_MS);
                // Grow by doubling for the next iteration; cap is applied
                // on the next push. Overflow of `delayMs` is irrelevant
                // once the cap has kicked in.
                delayMs = delayMs * 2;
            }
            return { backoffNs: out, maxDeliver: retry.attempts + 1 };
        }
    }
}
