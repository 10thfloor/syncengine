import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { bus } from '@syncengine/core';
import { on, From, isSubscription } from '../bus-on';

const schema = z.object({
    orderId: z.string(),
    event: z.enum(['placed', 'paid', 'shipped']),
});
const orderEvents = bus('orderEvents', { schema });

describe('on(bus)', () => {
    it('returns a Subscription carrying the bus reference', () => {
        const sub = on(orderEvents);
        expect(sub.$tag).toBe('bus-subscription');
        expect(sub.bus).toBe(orderEvents);
        expect(sub.predicate).toBeUndefined();
        expect(sub.cursor).toBeUndefined();
    });

    it('.where captures the predicate immutably', () => {
        const sub = on(orderEvents).where((e) => e.event === 'paid');
        expect(sub.predicate).toBeDefined();
        expect(sub.predicate!({ orderId: '1', event: 'paid' })).toBe(true);
        expect(sub.predicate!({ orderId: '1', event: 'placed' })).toBe(false);
    });

    it('chaining .where twice replaces (does not compose) — the user decides', () => {
        const s = on(orderEvents)
            .where(() => true)
            .where((e) => e.event === 'shipped');
        expect(s.predicate!({ orderId: '1', event: 'shipped' })).toBe(true);
        expect(s.predicate!({ orderId: '1', event: 'placed' })).toBe(false);
    });

    it('.from + .where compose without losing either value', () => {
        const s = on(orderEvents)
            .where((e) => e.event === 'paid')
            .from(From.beginning());
        expect(s.predicate).toBeDefined();
        expect(s.cursor).toEqual({ kind: 'beginning' });
    });

    it('isSubscription type guard', () => {
        expect(isSubscription(on(orderEvents))).toBe(true);
        expect(isSubscription({ $tag: 'bus' })).toBe(false);
        expect(isSubscription(null)).toBe(false);
    });
});

describe('From — typed cursor factories', () => {
    it('beginning / latest are marker configs', () => {
        expect(From.beginning()).toEqual({ kind: 'beginning' });
        expect(From.latest()).toEqual({ kind: 'latest' });
    });

    it('sequence carries the seq number', () => {
        expect(From.sequence(42)).toEqual({ kind: 'sequence', seq: 42 });
        expect(From.sequence(0)).toEqual({ kind: 'sequence', seq: 0 });
    });

    it('sequence rejects negative / non-integer', () => {
        expect(() => From.sequence(-1)).toThrow(/non-negative|integer/);
        expect(() => From.sequence(1.5)).toThrow(/integer/);
    });

    it('time accepts Date and string', () => {
        const d = new Date('2026-04-20T00:00:00Z');
        expect(From.time(d)).toEqual({ kind: 'time', at: d.toISOString() });
        expect(From.time('2026-04-20T00:00:00Z')).toEqual({ kind: 'time', at: '2026-04-20T00:00:00Z' });
    });
});
