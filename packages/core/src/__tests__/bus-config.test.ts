import { describe, it, expect } from 'vitest';
import {
    Retention, Delivery, Storage, Retry, Backoff,
} from '../bus-config';
import { days, seconds, minutes } from '../duration';

describe('Retention', () => {
    it('durableFor returns a limits-retention config with sensible defaults', () => {
        const r = Retention.durableFor(days(30));
        expect(r.kind).toBe('limits');
        expect(r.maxAge.ms).toBe(86_400_000 * 30);
        expect(r.discard).toBe('old');
        expect(r.maxMsgs).toBeUndefined();
    });

    it('maxMessages chains without losing earlier fields', () => {
        const r = Retention.durableFor(days(7)).maxMessages(1_000);
        expect(r.maxMsgs).toBe(1_000);
        expect(r.maxAge.ms).toBe(days(7).ms);
    });

    it('discardOldest / discardNewest flip the policy and preserve messages cap', () => {
        const r1 = Retention.durableFor(days(7)).maxMessages(500).discardNewest();
        expect(r1.discard).toBe('new');
        expect(r1.maxMsgs).toBe(500);

        const r2 = r1.discardOldest();
        expect(r2.discard).toBe('old');
        expect(r2.maxMsgs).toBe(500);
    });

    it('chaining is order-independent', () => {
        const a = Retention.durableFor(days(1)).discardNewest().maxMessages(10);
        const b = Retention.durableFor(days(1)).maxMessages(10).discardNewest();
        expect(a.discard).toBe(b.discard);
        expect(a.maxMsgs).toBe(b.maxMsgs);
    });
});

describe('Delivery', () => {
    it('fanout / queue / interest are distinct configs', () => {
        expect(Delivery.fanout().mode).toBe('fanout');
        expect(Delivery.queue().mode).toBe('queue');
        expect(Delivery.interest().mode).toBe('interest');
    });

    it('mode is the only field', () => {
        const d = Delivery.fanout();
        expect(Object.keys(d)).toEqual(['mode']);
    });
});

describe('Storage', () => {
    it('file() and memory() default to single replica', () => {
        expect(Storage.file()).toEqual({ kind: 'file', replicas: 1 });
        expect(Storage.memory()).toEqual({ kind: 'memory', replicas: 1 });
    });

    it('replicatedFile sets replicas', () => {
        expect(Storage.replicatedFile({ replicas: 3 }).replicas).toBe(3);
        expect(Storage.replicatedFile({ replicas: 3 }).kind).toBe('file');
    });

    it('replicatedFile rejects replicas < 1', () => {
        expect(() => Storage.replicatedFile({ replicas: 0 })).toThrow(/replicas/);
        expect(() => Storage.replicatedFile({ replicas: -1 })).toThrow(/replicas/);
    });

    it('replicatedFile rejects non-integer replicas', () => {
        expect(() => Storage.replicatedFile({ replicas: 1.5 })).toThrow(/replicas/);
    });
});

describe('Backoff', () => {
    it('exponential carries initial + max', () => {
        const b = Backoff.exponential({ initial: seconds(1), max: minutes(1) });
        expect(b.kind).toBe('exponential');
        if (b.kind !== 'exponential') return;
        expect(b.initial.ms).toBe(1_000);
        expect(b.max.ms).toBe(60_000);
    });

    it('fixed carries interval', () => {
        const b = Backoff.fixed({ interval: seconds(30) });
        expect(b.kind).toBe('fixed');
        if (b.kind !== 'fixed') return;
        expect(b.interval.ms).toBe(30_000);
    });
});

describe('Retry', () => {
    it('exponential + fixed + none', () => {
        const e = Retry.exponential({ attempts: 5, initial: seconds(1), max: minutes(1) });
        expect(e.kind).toBe('exponential');
        if (e.kind !== 'exponential') return;
        expect(e.attempts).toBe(5);

        const f = Retry.fixed({ attempts: 3, interval: seconds(10) });
        expect(f.kind).toBe('fixed');

        const n = Retry.none();
        expect(n.kind).toBe('none');
    });

    it('rejects negative or non-integer attempts', () => {
        expect(() => Retry.exponential({ attempts: -1, initial: seconds(1), max: seconds(1) })).toThrow(/attempts/);
        expect(() => Retry.fixed({ attempts: 1.5, interval: seconds(1) })).toThrow(/attempts/);
    });
});
