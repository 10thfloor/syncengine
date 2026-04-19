import { describe, it, expect } from 'vitest';
import { service } from '@syncengine/core';
import type * as restate from '@restatedev/restate-sdk';
import { wrapWorkflowHandler } from '../workflow';

const shipping = service('shipping', {
    async create(orderId: string) { return { trackingId: `T-${orderId}` }; },
});

const notifications = service('notifications', {
    async sendSlack(_payload: { channel: string; text: string }) { /* noop */ },
});

// Minimal Restate ctx stand-in. The wrapper only ever augments it
// with `.services`; it doesn't read any Restate primitives.
const fakeCtx = () => ({ key: 'ws1/order1' } as unknown as restate.WorkflowContext);

describe('wrapWorkflowHandler — ctx.services injection', () => {
    it('attaches resolved services to ctx before invoking the user handler', async () => {
        let observed: unknown;
        const resolved = {
            shipping: { create: shipping.$methods.create },
        };
        const wrapped = wrapWorkflowHandler(async (ctx) => {
            observed = (ctx as unknown as { services: Record<string, unknown> }).services;
        }, resolved as never);

        await wrapped(fakeCtx(), undefined);

        expect(observed).toBeTypeOf('object');
        expect(observed).toHaveProperty('shipping');
        expect(typeof (observed as { shipping: { create: unknown } }).shipping.create).toBe('function');
    });

    it('empty services object when none are declared', async () => {
        let observed: unknown;
        const wrapped = wrapWorkflowHandler(async (ctx) => {
            observed = (ctx as unknown as { services: Record<string, unknown> }).services;
        }, {});

        await wrapped(fakeCtx(), undefined);

        expect(observed).toEqual({});
    });

    it('multiple services all attached', async () => {
        let observed: unknown;
        const resolved = {
            shipping: { create: shipping.$methods.create },
            notifications: { sendSlack: notifications.$methods.sendSlack },
        };
        const wrapped = wrapWorkflowHandler(async (ctx) => {
            observed = (ctx as unknown as { services: Record<string, unknown> }).services;
        }, resolved as never);

        await wrapped(fakeCtx(), undefined);

        expect(Object.keys(observed as Record<string, unknown>)).toEqual(['shipping', 'notifications']);
    });

    it('passes input through unchanged', async () => {
        let receivedInput: unknown;
        const wrapped = wrapWorkflowHandler<{ id: string }>(async (_ctx, input) => {
            receivedInput = input;
        }, {});

        await wrapped(fakeCtx(), { id: 'x' });

        expect(receivedInput).toEqual({ id: 'x' });
    });

    it('propagates handler errors', async () => {
        const wrapped = wrapWorkflowHandler(async () => {
            throw new Error('boom');
        }, {});

        await expect(wrapped(fakeCtx(), undefined)).rejects.toThrow('boom');
    });
});
