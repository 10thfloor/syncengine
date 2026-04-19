import { describe, it, expect } from 'vitest';
import { bytes, type Bytes } from '../bytes';

describe('bytes factory', () => {
    it('construct branded Bytes values with correct byte counts', () => {
        expect(bytes.b(512).bytes).toBe(512);
        expect(bytes.kib(1).bytes).toBe(1024);
        expect(bytes.mib(1).bytes).toBe(1024 * 1024);
        expect(bytes.gib(1).bytes).toBe(1024 * 1024 * 1024);
    });

    it('Bytes is not assignable from a plain number (compile-time)', () => {
        // The @ts-expect-error below is the real test — if TS ever stops
        // flagging this line, the whole file stops compiling.
        // @ts-expect-error — plain number rejected
        const b: Bytes = 100;
        expect(typeof b).toBe('number');
    });

    it('rejects non-integer counts', () => {
        expect(() => bytes.kib(1.5)).toThrow(/integer/);
    });

    it('rejects negative counts', () => {
        expect(() => bytes.mib(-1)).toThrow(/non-negative/);
    });

    it('zero is a valid count', () => {
        expect(bytes.b(0).bytes).toBe(0);
    });
});
