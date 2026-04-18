import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { bus, Concurrency, Rate } from '@syncengine/core';
import { on, From, isSubscription, deriveInvocationId } from '../bus-on';

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

describe('on().ordered / .orderedBy / .key (invocation-id modifiers)', () => {
    it('default keying is perMessage when no modifier called', () => {
        const s = on(orderEvents);
        expect(s.keying).toBeUndefined();
    });

    it('.ordered() sets singleton keying', () => {
        const s = on(orderEvents).ordered();
        expect(s.keying).toEqual({ kind: 'singleton' });
    });

    it('.orderedBy(fn) carries the key function', () => {
        const s = on(orderEvents).orderedBy((e) => e.orderId);
        expect(s.keying?.kind).toBe('byKey');
        if (s.keying?.kind === 'byKey') {
            expect(s.keying.fn({ orderId: 'O1', event: 'paid' })).toBe('O1');
        }
    });

    it('.key(fn) carries the custom key function', () => {
        const s = on(orderEvents).key((e) => `custom:${e.orderId}`);
        expect(s.keying?.kind).toBe('custom');
        if (s.keying?.kind === 'custom') {
            expect(s.keying.fn({ orderId: 'O9', event: 'paid' })).toBe('custom:O9');
        }
    });

    it('modifiers compose with .where and .from', () => {
        const s = on(orderEvents)
            .where((e) => e.event === 'paid')
            .from(From.latest())
            .orderedBy((e) => e.orderId);
        expect(s.predicate).toBeDefined();
        expect(s.cursor).toEqual({ kind: 'latest' });
        expect(s.keying?.kind).toBe('byKey');
    });

    it('later modifier replaces earlier — user-chosen semantics', () => {
        const s = on(orderEvents)
            .ordered()
            .orderedBy((e) => e.orderId);
        expect(s.keying?.kind).toBe('byKey');
    });

    it('.orderedBy / .key reject non-function arg', () => {
        expect(() => on(orderEvents).orderedBy(42 as never)).toThrow(/orderedBy/);
        expect(() => on(orderEvents).key('static' as never)).toThrow(/key/);
    });
});

describe('Concurrency + Rate factories', () => {
    it('Concurrency.global carries the limit', () => {
        expect(Concurrency.global(10)).toEqual({ kind: 'global', limit: 10 });
    });

    it('Concurrency.perKey carries the limit', () => {
        expect(Concurrency.perKey(3)).toEqual({ kind: 'perKey', limit: 3 });
    });

    it('Concurrency rejects non-positive / non-integer limits', () => {
        expect(() => Concurrency.global(0)).toThrow(/positive integer/);
        expect(() => Concurrency.global(-1)).toThrow(/positive integer/);
        expect(() => Concurrency.global(1.5)).toThrow(/positive integer/);
        expect(() => Concurrency.perKey(0)).toThrow(/positive integer/);
    });

    it('Rate.perSecond stores rate directly', () => {
        expect(Rate.perSecond(100)).toEqual({ kind: 'tokenBucket', perSecond: 100 });
    });

    it('Rate.perMinute / perHour compile to perSecond', () => {
        expect(Rate.perMinute(60)).toEqual({ kind: 'tokenBucket', perSecond: 1 });
        expect(Rate.perHour(3600)).toEqual({ kind: 'tokenBucket', perSecond: 1 });
    });

    it('Rate rejects non-positive / non-finite values', () => {
        expect(() => Rate.perSecond(0)).toThrow(/positive finite/);
        expect(() => Rate.perSecond(-1)).toThrow(/positive finite/);
        expect(() => Rate.perSecond(Infinity)).toThrow(/positive finite/);
        expect(() => Rate.perMinute(NaN)).toThrow(/positive finite/);
    });
});

describe('on().concurrency / .rate (throttle modifiers)', () => {
    it('.concurrency(Concurrency.global(n)) attaches the config', () => {
        const s = on(orderEvents).concurrency(Concurrency.global(5));
        expect(s.$concurrency).toEqual({ kind: 'global', limit: 5 });
    });

    it('.rate(Rate.perSecond(n)) attaches the config', () => {
        const s = on(orderEvents).rate(Rate.perSecond(100));
        expect(s.$rate).toEqual({ kind: 'tokenBucket', perSecond: 100 });
    });

    it('composes with every other modifier', () => {
        const s = on(orderEvents)
            .where((e) => e.event === 'paid')
            .from(From.latest())
            .orderedBy((e) => e.orderId)
            .concurrency(Concurrency.perKey(3))
            .rate(Rate.perSecond(50));
        expect(s.predicate).toBeDefined();
        expect(s.cursor).toEqual({ kind: 'latest' });
        expect(s.keying?.kind).toBe('byKey');
        expect(s.$concurrency).toEqual({ kind: 'perKey', limit: 3 });
        expect(s.$rate).toEqual({ kind: 'tokenBucket', perSecond: 50 });
    });

    it('later modifier replaces earlier', () => {
        const s = on(orderEvents)
            .concurrency(Concurrency.global(5))
            .concurrency(Concurrency.global(10));
        expect(s.$concurrency).toEqual({ kind: 'global', limit: 10 });
    });
});

describe('deriveInvocationId — pure derivation used by BusDispatcher', () => {
    const event = { orderId: 'O7', event: 'paid' as const };

    it('default (perMessage) uses ${bus}:${seq}', () => {
        expect(deriveInvocationId('orderEvents', 42n, event, undefined)).toBe('orderEvents:42');
        expect(deriveInvocationId('orderEvents', 42n, event, { kind: 'perMessage' })).toBe('orderEvents:42');
    });

    it('number seq is coerced to string cleanly', () => {
        expect(deriveInvocationId('b', 3, event, undefined)).toBe('b:3');
    });

    it('singleton collapses every message to one id', () => {
        expect(deriveInvocationId('orderEvents', 1n, event, { kind: 'singleton' })).toBe('orderEvents:singleton');
        expect(deriveInvocationId('orderEvents', 2n, event, { kind: 'singleton' })).toBe('orderEvents:singleton');
    });

    it('byKey keys on fn(event) — same key, same id across redeliveries', () => {
        const keying = { kind: 'byKey' as const, fn: (e: typeof event) => e.orderId };
        expect(deriveInvocationId('orderEvents', 1n, event, keying)).toBe('orderEvents:O7');
        expect(deriveInvocationId('orderEvents', 99n, event, keying)).toBe('orderEvents:O7');
        expect(deriveInvocationId('orderEvents', 1n, { ...event, orderId: 'O8' }, keying))
            .toBe('orderEvents:O8');
    });

    it('custom skips the ${bus}: prefix entirely', () => {
        const keying = { kind: 'custom' as const, fn: (e: typeof event) => `tenant:acme:order:${e.orderId}` };
        expect(deriveInvocationId('orderEvents', 1n, event, keying)).toBe('tenant:acme:order:O7');
    });
});
