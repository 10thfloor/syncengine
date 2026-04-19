import { describe, it, expect } from 'vitest';
import { service, override } from '@syncengine/core';
import { ServiceContainer } from '../service-container';

describe('ServiceContainer', () => {
    const payments = service('payments', {
        async charge(amount: number) { return { id: 'ch_real', amount }; },
        async refund(id: string) { return { id, status: 'refunded' }; },
    });

    const notifications = service('notifications', {
        async send(to: string, msg: string) { return { sent: true }; },
    });

    it('registers services and resolves them by def', () => {
        const container = new ServiceContainer([payments, notifications]);
        const resolved = container.resolve(payments);
        expect(typeof resolved.charge).toBe('function');
        expect(typeof resolved.refund).toBe('function');
    });

    it('calls through to the real implementation', async () => {
        const container = new ServiceContainer([payments]);
        const resolved = container.resolve(payments);
        const result = await resolved.charge(100);
        expect(result).toEqual({ id: 'ch_real', amount: 100 });
    });

    it('applies total override', async () => {
        const testPayments = override(payments, {
            async charge(amount: number) { return { id: 'ch_test', amount }; },
            async refund(id: string) { return { id, status: 'test_refunded' }; },
        });
        const container = new ServiceContainer([payments], [testPayments]);
        const resolved = container.resolve(payments);
        const result = await resolved.charge(100);
        expect(result).toEqual({ id: 'ch_test', amount: 100 });
    });

    it('applies partial override (unoverridden methods use real impl)', async () => {
        const partialOverride = override(payments, {
            async charge(amount: number) { return { id: 'ch_partial', amount }; },
        }, { partial: true });
        const container = new ServiceContainer([payments], [partialOverride]);
        const resolved = container.resolve(payments);

        const chargeResult = await resolved.charge(50);
        expect(chargeResult).toEqual({ id: 'ch_partial', amount: 50 });

        const refundResult = await resolved.refund('ch_1');
        expect(refundResult).toEqual({ id: 'ch_1', status: 'refunded' });
    });

    it('throws on resolving unregistered service', () => {
        const container = new ServiceContainer([]);
        expect(() => container.resolve(payments)).toThrow(/not registered/);
    });

    it('resolves multiple services for a dependency list', () => {
        const container = new ServiceContainer([payments, notifications]);
        const resolved = container.resolveAll([payments, notifications]);
        expect(resolved.payments).toBeDefined();
        expect(resolved.notifications).toBeDefined();
        expect(typeof resolved.payments.charge).toBe('function');
        expect(typeof resolved.notifications.send).toBe('function');
    });
});
