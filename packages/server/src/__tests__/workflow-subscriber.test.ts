import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { bus, service } from '@syncengine/core';
import { defineWorkflow, isBusSubscriberWorkflow } from '../workflow';
import { on, From } from '../bus-on';

const orderEvents = bus('orderEvents', {
    schema: z.object({ orderId: z.string(), event: z.string() }),
});

const shipping = service('shipping', {
    async create(_orderId: string) { return { trackingId: 'x' }; },
});

describe('defineWorkflow({ on })', () => {
    it('captures subscription metadata on the workflow def', () => {
        const wf = defineWorkflow(
            'shipOnPay',
            { on: on(orderEvents).where((e) => e.event === 'paid') },
            async () => { /* noop */ },
        );
        expect(wf.$tag).toBe('workflow');
        expect(wf.$name).toBe('shipOnPay');
        expect(isBusSubscriberWorkflow(wf as never)).toBe(true);
        expect(wf.$subscription!.bus.$name).toBe('orderEvents');
    });

    it('non-subscriber workflows have no $subscription', () => {
        const wf = defineWorkflow(
            'processPayment',
            async () => { /* noop */ },
        );
        expect(isBusSubscriberWorkflow(wf)).toBe(false);
        expect(wf.$subscription).toBeUndefined();
    });

    it('services + on co-exist and both land on the def', () => {
        const wf = defineWorkflow(
            'shipOnPay',
            {
                on: on(orderEvents).from(From.beginning()),
                services: [shipping],
            },
            async () => { /* noop */ },
        );
        expect(wf.$services).toEqual([shipping]);
        expect(wf.$subscription!.cursor).toEqual({ kind: 'beginning' });
    });
});
