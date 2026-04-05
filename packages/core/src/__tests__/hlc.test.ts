import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    hlcTick,
    hlcMerge,
    hlcPack,
    hlcCompare,
    type HLCState,
} from '../hlc';

describe('Hybrid Logical Clock (HLC)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-02T12:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('hlcTick', () => {
        it('advances timestamp when wall clock moved forward', () => {
            const state: HLCState = { ts: 1000, count: 5 };
            vi.setSystemTime(2000);

            const result = hlcTick(state);

            expect(result.ts).toBe(2000);
            expect(result.count).toBe(0);
        });

        it('increments counter when wall clock unchanged', () => {
            const state: HLCState = { ts: 1000, count: 5 };
            vi.setSystemTime(1000);

            const result = hlcTick(state);

            expect(result.ts).toBe(1000);
            expect(result.count).toBe(6);
        });

        it('starts counter at 0 on first tick', () => {
            const state: HLCState = { ts: 1000, count: 0 };
            vi.setSystemTime(2000);

            const result = hlcTick(state);

            expect(result.count).toBe(0);
        });

        it('handles multiple consecutive ticks at same wall time', () => {
            let state: HLCState = { ts: 1000, count: 0 };
            vi.setSystemTime(1000);

            state = hlcTick(state);
            expect(state).toEqual({ ts: 1000, count: 1 });

            state = hlcTick(state);
            expect(state).toEqual({ ts: 1000, count: 2 });

            state = hlcTick(state);
            expect(state).toEqual({ ts: 1000, count: 3 });
        });
    });

    describe('hlcMerge', () => {
        it('advances to wall time when both local and remote in past', () => {
            const local: HLCState = { ts: 500, count: 3 };
            const remote: HLCState = { ts: 600, count: 2 };
            vi.setSystemTime(1000);

            const result = hlcMerge(local, remote);

            expect(result.ts).toBe(1000);
            expect(result.count).toBe(0);
        });

        it('takes remote timestamp and increments when remote ahead', () => {
            const local: HLCState = { ts: 500, count: 5 };
            const remote: HLCState = { ts: 800, count: 3 };
            vi.setSystemTime(400);

            const result = hlcMerge(local, remote);

            expect(result.ts).toBe(800);
            expect(result.count).toBe(4);
        });

        it('increments counter when timestamps equal', () => {
            const local: HLCState = { ts: 500, count: 3 };
            const remote: HLCState = { ts: 500, count: 5 };
            vi.setSystemTime(400);

            const result = hlcMerge(local, remote);

            expect(result.ts).toBe(500);
            expect(result.count).toBe(6); // max(3, 5) + 1
        });

        it('increments counter when timestamps equal and local count higher', () => {
            const local: HLCState = { ts: 500, count: 7 };
            const remote: HLCState = { ts: 500, count: 2 };
            vi.setSystemTime(400);

            const result = hlcMerge(local, remote);

            expect(result.ts).toBe(500);
            expect(result.count).toBe(8); // max(7, 2) + 1
        });

        it('keeps local timestamp and increments when local ahead', () => {
            const local: HLCState = { ts: 800, count: 2 };
            const remote: HLCState = { ts: 500, count: 5 };
            vi.setSystemTime(400);

            const result = hlcMerge(local, remote);

            expect(result.ts).toBe(800);
            expect(result.count).toBe(3);
        });

        it('handles merge after multiple ticks', () => {
            let state: HLCState = { ts: 1000, count: 0 };
            vi.setSystemTime(1000);

            // Tick a few times
            state = hlcTick(state);
            state = hlcTick(state);
            expect(state).toEqual({ ts: 1000, count: 2 });

            // Merge with remote
            const remote: HLCState = { ts: 1000, count: 1 };
            state = hlcMerge(state, remote);

            expect(state.ts).toBe(1000);
            expect(state.count).toBe(3); // max(2, 1) + 1
        });
    });

    describe('hlcPack', () => {
        it('packs small values correctly', () => {
            const hlc: HLCState = { ts: 100, count: 50 };
            const packed = hlcPack(hlc);
            expect(packed).toBe(100 * 65536 + 50);
            expect(packed).toBe(6553650);
        });

        it('packs large timestamp with large count', () => {
            const hlc: HLCState = { ts: 1000000, count: 65535 };
            const packed = hlcPack(hlc);
            expect(packed).toBe(1000000 * 65536 + 65535);
        });

        it('packs zero values', () => {
            const hlc: HLCState = { ts: 0, count: 0 };
            const packed = hlcPack(hlc);
            expect(packed).toBe(0);
        });

        it('maintains relative ordering', () => {
            const a: HLCState = { ts: 100, count: 10 };
            const b: HLCState = { ts: 100, count: 20 };
            const c: HLCState = { ts: 200, count: 5 };

            const packed_a = hlcPack(a);
            const packed_b = hlcPack(b);
            const packed_c = hlcPack(c);

            expect(packed_a < packed_b).toBe(true);
            expect(packed_b < packed_c).toBe(true);
        });
    });

    describe('hlcCompare', () => {
        it('returns -1 when a is earlier', () => {
            const a: HLCState = { ts: 100, count: 5 };
            const b: HLCState = { ts: 200, count: 5 };

            const result = hlcCompare(a, b);
            expect(result).toBe(-1);
        });

        it('returns 1 when a is later', () => {
            const a: HLCState = { ts: 200, count: 5 };
            const b: HLCState = { ts: 100, count: 5 };

            const result = hlcCompare(a, b);
            expect(result).toBe(1);
        });

        it('returns 0 when equal', () => {
            const a: HLCState = { ts: 100, count: 5 };
            const b: HLCState = { ts: 100, count: 5 };

            const result = hlcCompare(a, b);
            expect(result).toBe(0);
        });

        it('compares by timestamp first', () => {
            const a: HLCState = { ts: 100, count: 99 };
            const b: HLCState = { ts: 101, count: 0 };

            expect(hlcCompare(a, b)).toBe(-1);
        });

        it('compares by count when timestamps equal', () => {
            const a: HLCState = { ts: 100, count: 5 };
            const b: HLCState = { ts: 100, count: 10 };

            expect(hlcCompare(a, b)).toBe(-1);
            expect(hlcCompare(b, a)).toBe(1);
        });

        it('works for ordering multiple values', () => {
            const values: HLCState[] = [
                { ts: 200, count: 5 },
                { ts: 100, count: 20 },
                { ts: 100, count: 10 },
                { ts: 200, count: 0 },
            ];

            // Sort using hlcCompare
            const sorted = [...values].sort((a, b) => hlcCompare(a, b));

            expect(sorted[0]).toEqual({ ts: 100, count: 10 });
            expect(sorted[1]).toEqual({ ts: 100, count: 20 });
            expect(sorted[2]).toEqual({ ts: 200, count: 0 });
            expect(sorted[3]).toEqual({ ts: 200, count: 5 });
        });
    });

    describe('HLC causality semantics', () => {
        it('maintains causality: tick-then-merge', () => {
            let state: HLCState = { ts: 1000, count: 0 };
            vi.setSystemTime(1000);

            // Local event
            state = hlcTick(state);
            expect(state).toEqual({ ts: 1000, count: 1 });

            // Receive remote at same logical time
            const remote: HLCState = { ts: 1000, count: 1 };
            state = hlcMerge(state, remote);

            // Counter must advance to prevent conflicts
            expect(state.ts).toBe(1000);
            expect(state.count).toBe(2);
        });

        it('handles fast-then-slow clock scenario', () => {
            let state: HLCState = { ts: 1000, count: 0 };
            vi.setSystemTime(1000);

            // Clock jumps forward
            vi.setSystemTime(2000);
            state = hlcTick(state);
            expect(state.ts).toBe(2000);

            // Receive old remote event
            const remote: HLCState = { ts: 1500, count: 0 };
            state = hlcMerge(state, remote);

            // Should not go backward
            expect(state.ts).toBe(2000);
        });

        it('ensures monotonic increment across operations', () => {
            let state: HLCState = { ts: 1000, count: 0 };
            vi.setSystemTime(1000);

            const hlcs: HLCState[] = [];

            // Generate several events
            for (let i = 0; i < 5; i++) {
                state = hlcTick(state);
                hlcs.push({ ...state });
            }

            // All should be strictly ordered
            for (let i = 0; i < hlcs.length - 1; i++) {
                expect(hlcCompare(hlcs[i], hlcs[i + 1])).toBe(-1);
            }
        });
    });
});
