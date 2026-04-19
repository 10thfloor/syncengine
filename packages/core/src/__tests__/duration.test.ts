import { describe, it, expect } from 'vitest';
import {
    milliseconds, seconds, minutes, hours, days,
    type Duration,
} from '../duration';

describe('Duration factories', () => {
    it('construct branded Duration values with correct ms', () => {
        expect(milliseconds(42).ms).toBe(42);
        expect(seconds(1).ms).toBe(1000);
        expect(minutes(1).ms).toBe(60_000);
        expect(hours(1).ms).toBe(3_600_000);
        expect(days(1).ms).toBe(86_400_000);
    });

    it('Duration is not assignable from a plain number (compile-time)', () => {
        // The @ts-expect-error below is the real test — if TS ever stops
        // flagging this line, the whole file stops compiling.
        // @ts-expect-error — plain number rejected
        const d: Duration = 100;
        // runtime: just note we reached here.
        expect(typeof d).toBe('number');
    });

    it('rejects non-integer counts', () => {
        expect(() => seconds(1.5)).toThrow(/integer/);
        expect(() => minutes(0.1)).toThrow(/integer/);
    });

    it('rejects negative counts', () => {
        expect(() => minutes(-1)).toThrow(/non-negative/);
        expect(() => days(-365)).toThrow(/non-negative/);
    });

    it('zero is a valid count', () => {
        expect(seconds(0).ms).toBe(0);
        expect(days(0).ms).toBe(0);
    });
});
