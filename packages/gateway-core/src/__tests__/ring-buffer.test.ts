import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../ring-buffer.js';

describe('RingBuffer', () => {
    it('stores and retrieves entries', () => {
        const ring = new RingBuffer(5);
        ring.push(1, { data: 'a' }, 'c1');
        ring.push(2, { data: 'b' }, 'c2');
        const entries = ring.rangeFrom(0);
        expect(entries).toHaveLength(2);
        expect(entries[0]!.seq).toBe(1);
        expect(entries[1]!.seq).toBe(2);
    });

    it('rangeFrom returns entries after the given seq', () => {
        const ring = new RingBuffer(10);
        ring.push(10, { x: 1 }, 'c1');
        ring.push(11, { x: 2 }, 'c1');
        ring.push(12, { x: 3 }, 'c1');
        const entries = ring.rangeFrom(11);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.seq).toBe(12);
    });

    it('wraps around when capacity is exceeded', () => {
        const ring = new RingBuffer(3);
        ring.push(1, { a: 1 }, 'c1');
        ring.push(2, { a: 2 }, 'c1');
        ring.push(3, { a: 3 }, 'c1');
        ring.push(4, { a: 4 }, 'c1');
        expect(ring.oldestSeq()).toBe(2);
        expect(ring.newestSeq()).toBe(4);
        expect(ring.rangeFrom(0)).toHaveLength(3);
        expect(ring.rangeFrom(0)[0]!.seq).toBe(2);
    });

    it('containsSeq returns true for seqs in range', () => {
        const ring = new RingBuffer(5);
        ring.push(10, {}, 'c1');
        ring.push(11, {}, 'c1');
        ring.push(12, {}, 'c1');
        expect(ring.containsSeq(10)).toBe(true);
        expect(ring.containsSeq(12)).toBe(true);
        expect(ring.containsSeq(9)).toBe(false);
        expect(ring.containsSeq(13)).toBe(false);
    });

    it('returns empty array when empty', () => {
        const ring = new RingBuffer(5);
        expect(ring.rangeFrom(0)).toEqual([]);
        expect(ring.oldestSeq()).toBe(-1);
        expect(ring.newestSeq()).toBe(-1);
    });
});
