import { describe, it, expect } from 'vitest';
import { service } from '@syncengine/core';
import { defineWorkflow } from '../workflow';

describe('defineWorkflow with services', () => {
    const payments = service('payments', {
        async charge(amount: number) { return { id: 'ch_1', amount }; },
    });

    it('accepts a services option', () => {
        const wf = defineWorkflow('testWf', { services: [payments] }, async (ctx, input: { n: number }) => {
            void ctx; void input;
        });
        expect(wf.$tag).toBe('workflow');
        expect(wf.$name).toBe('testWf');
        expect(wf.$services).toEqual([payments]);
    });

    it('still works without services (backwards compat)', () => {
        const wf = defineWorkflow('simpleWf', async (ctx, input: string) => {
            void ctx; void input;
        });
        expect(wf.$tag).toBe('workflow');
        expect(wf.$services).toEqual([]);
    });
});
