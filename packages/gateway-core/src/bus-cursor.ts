/**
 * `cursorToDeliverPolicy` — map the bus-subscription cursor into a
 * partial `ConsumerConfig` JetStream understands.
 *
 * The upstream `CursorConfig` is declared in `@syncengine/server`'s
 * `bus-on.ts`, but `@syncengine/gateway-core` must not depend on
 * `@syncengine/server` (that would reverse the package topology —
 * server depends on gateway-core, not the other way around). So the
 * shape is mirrored here. The structural compatibility is the
 * contract; any drift surfaces the first time the two shapes meet in
 * `loadDefinitions` (Task 8).
 */

import { DeliverPolicy, type ConsumerConfig } from '@nats-io/jetstream';

export type CursorConfig =
    | { readonly kind: 'beginning' }
    | { readonly kind: 'latest' }
    | { readonly kind: 'sequence'; readonly seq: number }
    | { readonly kind: 'time'; readonly at: string };

/**
 * Returns the `deliver_policy` slice of a consumer config for the
 * given cursor. Callers spread the result into their full
 * `ConsumerConfig` — the other fields (name, ack_policy, filter, etc.)
 * are the dispatcher's concern, not the cursor's.
 */
export function cursorToDeliverPolicy(cursor: CursorConfig): Partial<ConsumerConfig> {
    switch (cursor.kind) {
        case 'beginning':
            return { deliver_policy: DeliverPolicy.All };
        case 'latest':
            return { deliver_policy: DeliverPolicy.New };
        case 'sequence':
            return { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: cursor.seq };
        case 'time':
            return { deliver_policy: DeliverPolicy.StartTime, opt_start_time: cursor.at };
    }
}
