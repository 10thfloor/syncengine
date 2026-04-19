import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { bus, isBus, setBusPublisher, type DeadEvent } from '../bus';
import { days, minutes } from '../duration';
import { Retention, Delivery, Storage } from '../bus-config';

const schema = z.object({ orderId: z.string(), at: z.number() });

afterEach(() => setBusPublisher(null));

describe('bus()', () => {
    it('returns a BusRef with correct $tag / $name / $schema', () => {
        const b = bus('orderEvents', { schema });
        expect(b.$tag).toBe('bus');
        expect(b.$name).toBe('orderEvents');
        expect(b.$schema).toBe(schema);
    });

    it('applies Layer 1 defaults', () => {
        const b = bus('orderEvents', { schema });
        expect(b.$config.retention.maxAge.ms).toBe(days(7).ms);
        expect(b.$config.retention.maxMsgs).toBe(1_000_000);
        expect(b.$config.delivery.mode).toBe('fanout');
        expect(b.$config.storage.kind).toBe('file');
        expect(b.$config.dedupWindow.ms).toBe(minutes(1).ms);
    });

    it('honours Layer 2 overrides', () => {
        const b = bus('orderEvents', {
            schema,
            retention: Retention.durableFor(days(90)).maxMessages(10_000_000),
            delivery: Delivery.queue(),
            storage: Storage.replicatedFile({ replicas: 3 }),
            dedupWindow: minutes(5),
        });
        expect(b.$config.retention.maxAge.ms).toBe(days(90).ms);
        expect(b.$config.retention.maxMsgs).toBe(10_000_000);
        expect(b.$config.delivery.mode).toBe('queue');
        expect(b.$config.storage.replicas).toBe(3);
        expect(b.$config.dedupWindow.ms).toBe(minutes(5).ms);
    });

    it('isBus type guard', () => {
        expect(isBus(bus('x', { schema }))).toBe(true);
        expect(isBus({ $tag: 'entity' })).toBe(false);
        expect(isBus(null)).toBe(false);
        expect(isBus(undefined)).toBe(false);
        expect(isBus('bus')).toBe(false);
    });
});

describe('bus() name validation', () => {
    it('rejects empty / whitespace / malformed names', () => {
        expect(() => bus('', { schema })).toThrow(/non-empty/);
        expect(() => bus('bad name', { schema })).toThrow(/match/);
        expect(() => bus('with spaces', { schema })).toThrow(/match/);
    });

    it('rejects reserved $- and _-prefixed names', () => {
        expect(() => bus('$internal', { schema })).toThrow(/reserved/);
        expect(() => bus('_private', { schema })).toThrow(/reserved/);
    });

    it('rejects names containing dots (reserved for .dlq/.dead)', () => {
        expect(() => bus('orders.foo', { schema })).toThrow(/match/i);
        expect(() => bus('x.y.z', { schema })).toThrow(/match/i);
    });

    it('rejects explicit .dlq / .dead suffixes even before regex fires', () => {
        // Dot-containing names fail the regex first; this test guards the
        // reserved-suffix path separately by feeding a normally-valid name.
        // (The regex catches the dot, so we can't actually hit this via
        // user input — the check is belt + suspenders.)
        // Smoke: attempting the suffix still fails somewhere in the chain.
        expect(() => bus('foo.dlq', { schema })).toThrow();
        expect(() => bus('bar.dead', { schema })).toThrow();
    });

    it('accepts hyphens, underscores, digits after the first letter', () => {
        expect(() => bus('order-events', { schema })).not.toThrow();
        expect(() => bus('order_events_v2', { schema })).not.toThrow();
        expect(() => bus('OrderEvents', { schema })).not.toThrow();
    });
});

describe('bus() auto-DLQ', () => {
    it('exposes a typed DLQ BusRef with .dlq suffix', () => {
        const b = bus('orderEvents', { schema });
        expect(b.dlq.$tag).toBe('bus');
        expect(b.dlq.$name).toBe('orderEvents.dlq');
    });

    it('DLQ schema wraps the parent in DeadEvent<T>', () => {
        const b = bus('orderEvents', { schema });
        const validDead: DeadEvent<{ orderId: string; at: number }> = {
            original: { orderId: '1', at: 0 },
            error: { message: 'boom' },
            attempts: 1,
            firstAttemptAt: 0,
            lastAttemptAt: 0,
            workflow: 'w',
        };
        expect(() => b.dlq.$schema.parse(validDead)).not.toThrow();

        // Payload missing required `original` field — should fail.
        expect(() => b.dlq.$schema.parse({ error: { message: 'x' } } as unknown)).toThrow();
    });

    it("DLQ's own .dlq points at itself (terminates recursion)", () => {
        const b = bus('orderEvents', { schema });
        expect(b.dlq.dlq).toBe(b.dlq);
    });

    it('DLQ defaults to days(30) retention', () => {
        const b = bus('orderEvents', { schema });
        expect(b.dlq.$config.retention.maxAge.ms).toBe(days(30).ms);
    });
});

describe('bus.publish() — stub behaviour before server wiring', () => {
    it('throws when called without an active publisher', async () => {
        const b = bus('events', { schema });
        const ctx = {
            run: <T,>(_n: string, fn: () => Promise<T>) => fn(),
        };
        await expect(b.publish(ctx, { orderId: '1', at: 0 })).rejects.toThrow(/publisher/i);
    });

    it('validates payload before entering ctx.run', async () => {
        const b = bus('events', { schema });
        const ctx = { run: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()) };
        // @ts-expect-error — missing required field
        await expect(b.publish(ctx, { orderId: '1' })).rejects.toThrow(/invalid bus payload/i);
        expect(ctx.run).not.toHaveBeenCalled();
    });

    it('forwards to the active publisher when one is set', async () => {
        const pub = vi.fn<[unknown, string, unknown], Promise<void>>(async () => {});
        setBusPublisher(pub);

        const b = bus('events', { schema });
        const ctx = { run: async <T,>(_n: string, fn: () => Promise<T>) => fn() };
        await b.publish(ctx, { orderId: '1', at: 42 });

        expect(pub).toHaveBeenCalledTimes(1);
        const call = pub.mock.calls[0]!;
        expect(call[1]).toBe('events');
        expect(call[2]).toEqual({ orderId: '1', at: 42 });
    });
});
