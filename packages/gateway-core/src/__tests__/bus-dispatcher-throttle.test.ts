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
        ).toThrow(/Concurrency\.perKey.*not wired yet.*2b-B2/);
    });

    it('throws on Rate.* with an actionable hint', () => {
        expect(
            () => new BusDispatcher(makeConfig({ rate: Rate.perSecond(100) })),
        ).toThrow(/Rate.*wired yet.*2b-B2/);
    });

    it('Rate.perMinute triggers the same guard (rate is rate)', () => {
        expect(
            () => new BusDispatcher(makeConfig({ rate: Rate.perMinute(1200) })),
        ).toThrow(/Rate.*wired yet/);
    });
});
