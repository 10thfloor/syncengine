/**
 * Hybrid Logical Clock (HLC) implementation
 * Provides monotonically increasing timestamps with causality tracking
 */

import { HLC_COUNTER_MAX } from './constants';

export interface HLCState {
    ts: number;
    count: number;
}

/**
 * Tick the HLC forward, advancing the timestamp or counter
 * Called when generating a new local event
 */
export function hlcTick(state: HLCState): HLCState {
    const now = Date.now();
    if (now > state.ts) {
        // Wall clock advanced; reset counter
        return { ts: now, count: 0 };
    }
    // Same logical time; increment counter to maintain ordering
    return { ts: state.ts, count: state.count + 1 };
}

/**
 * Merge with a remote HLC state, advancing the local clock if needed
 * Called when receiving an event from a remote peer
 */
export function hlcMerge(state: HLCState, remote: HLCState): HLCState {
    const now = Date.now();

    // Both local and remote are in the past
    if (now > state.ts && now > remote.ts) {
        return { ts: now, count: 0 };
    }

    // Same logical timestamp; take max counter + 1 to preserve causality
    if (state.ts === remote.ts) {
        return { ts: state.ts, count: Math.max(state.count, remote.count) + 1 };
    }

    // Remote is ahead; follow it and increment to maintain ordering
    if (remote.ts > state.ts) {
        return { ts: remote.ts, count: remote.count + 1 };
    }

    // Local is ahead; stay there but increment counter
    return { ts: state.ts, count: state.count + 1 };
}

/**
 * Pack HLC state into a single number for storage/comparison.
 * Assumes count < HLC_COUNTER_MAX (2^16 = 65536).
 */
export function hlcPack(hlc: HLCState): number {
    return hlc.ts * HLC_COUNTER_MAX + hlc.count;
}

/**
 * Compare two HLC states for ordering
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
export function hlcCompare(a: HLCState, b: HLCState): number {
    if (a.ts !== b.ts) {
        return a.ts < b.ts ? -1 : 1;
    }
    if (a.count !== b.count) {
        return a.count < b.count ? -1 : 1;
    }
    return 0;
}
