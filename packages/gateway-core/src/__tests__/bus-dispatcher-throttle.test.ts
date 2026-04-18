import { describe, it, expect } from 'vitest';
import { Concurrency, Rate, Retry, seconds } from '@syncengine/core';
import { BusDispatcher } from '../bus-dispatcher.js';

function makeConfig(extras: Record<string, unknown>) {
    return {
        natsUrl: 'nats://localhost:4222',
        restateUrl: 'http://localhost:8080',
        workspaceId: 'ws1',
        busName: 'orderEvents',
        subscriberName: 'shipOnPay',
        dlqBusName: 'orderEvents.dlq',
        cursor: { kind: 'latest' as const },
        retry: Retry.exponential({
            attempts: 3,
            initial: seconds(1),
            max: seconds(60),
        }),
        ...extras,
    } as never;
}

describe('BusDispatcher — throttle modifier validation', () => {
    it('constructs OK with Concurrency.global', () => {
        expect(
            () => new BusDispatcher(makeConfig({ concurrency: Concurrency.global(10) })),
        ).not.toThrow();
    });

    it('constructs OK with no concurrency or rate', () => {
        expect(() => new BusDispatcher(makeConfig({}))).not.toThrow();
    });

    it('throws on Concurrency.perKey with an actionable hint', () => {
        expect(
            () => new BusDispatcher(makeConfig({ concurrency: Concurrency.perKey(5) })),
        ).toThrow(/Concurrency\.perKey.*concurrent-dispatch refactor/);
    });

    it('constructs OK with Rate.perSecond (token bucket wires at startup)', () => {
        expect(
            () => new BusDispatcher(makeConfig({ rate: Rate.perSecond(100) })),
        ).not.toThrow();
    });

    it('constructs OK with Rate.perMinute', () => {
        expect(
            () => new BusDispatcher(makeConfig({ rate: Rate.perMinute(1200) })),
        ).not.toThrow();
    });
});

// ── Token-bucket behaviour (Rate runtime) ────────────────────────────────
//
// `consumeToken` is private; we poke it via an instance cast to avoid
// exposing the bucket internals to the public API. The dispatcher
// doesn't otherwise touch Date.now directly during consume, so
// substituting a clock via vi.useFakeTimers is the cleanest harness.

import { vi } from 'vitest';

type TokenGate = { allowed: true } | { allowed: false; delayMs: number };

function consumeN(d: BusDispatcher, n: number): TokenGate[] {
    const consume = (
        d as unknown as { consumeToken(): TokenGate }
    ).consumeToken.bind(d);
    const out: TokenGate[] = [];
    for (let i = 0; i < n; i++) out.push(consume());
    return out;
}

describe('BusDispatcher — token bucket', () => {
    it('passes every consume when no rate is set', () => {
        const d = new BusDispatcher(makeConfig({}));
        for (const r of consumeN(d, 5)) expect(r.allowed).toBe(true);
    });

    it('allows a burst up to capacity then throttles', () => {
        // 10/sec → capacity = 10 tokens. First 10 consumes pass instantly,
        // 11th is throttled until the bucket refills.
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const d = new BusDispatcher(makeConfig({ rate: Rate.perSecond(10) }));
        const burst = consumeN(d, 10);
        expect(burst.every((r) => r.allowed)).toBe(true);

        const throttled = consumeN(d, 1)[0]!;
        expect(throttled.allowed).toBe(false);
        if (!throttled.allowed) {
            // 10/sec → one token per 100ms; a freshly drained bucket
            // needs ≥ 100ms before the next consume succeeds.
            expect(throttled.delayMs).toBe(100);
        }
        vi.useRealTimers();
    });

    it('refills over time — after the delay, next consume succeeds', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const d = new BusDispatcher(makeConfig({ rate: Rate.perSecond(10) }));
        consumeN(d, 10); // drain
        const first = consumeN(d, 1)[0]!;
        expect(first.allowed).toBe(false);

        // Advance clock past the reported delay.
        vi.setSystemTime(first.allowed ? 0 : first.delayMs);
        const second = consumeN(d, 1)[0]!;
        expect(second.allowed).toBe(true);
        vi.useRealTimers();
    });

    it('never NAKs with 0ms — always has a positive delay', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const d = new BusDispatcher(makeConfig({ rate: Rate.perSecond(1) }));
        consumeN(d, 1); // drain (capacity=1)
        const gate = consumeN(d, 1)[0]!;
        expect(gate.allowed).toBe(false);
        if (!gate.allowed) expect(gate.delayMs).toBeGreaterThanOrEqual(1);
        vi.useRealTimers();
    });

    it('sub-1/sec rates still work (perHour style)', () => {
        // Rate.perHour(3600) → perSecond=1 — same as above. But
        // Rate.perHour(1800) → perSecond=0.5 means the bucket needs 2s
        // to refill one token.
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const d = new BusDispatcher(makeConfig({ rate: Rate.perHour(1800) }));
        consumeN(d, 1); // drain (capacity=1)
        const gate = consumeN(d, 1)[0]!;
        expect(gate.allowed).toBe(false);
        if (!gate.allowed) expect(gate.delayMs).toBe(2000);
        vi.useRealTimers();
    });
});
