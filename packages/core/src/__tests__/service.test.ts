// packages/core/src/__tests__/service.test.ts
import { describe, it, expect } from 'vitest';
import { service, isService, override, type ServiceDef, type ServicePort } from '../service';

describe('service()', () => {
    it('creates a ServiceDef with $tag and $name', () => {
        const payments = service('payments', {
            async charge(amount: number, currency: string) {
                return { id: 'ch_1', status: 'succeeded' };
            },
        });
        expect(payments.$tag).toBe('service');
        expect(payments.$name).toBe('payments');
        expect(typeof payments.$methods.charge).toBe('function');
    });

    it('isService returns true for service defs', () => {
        const s = service('test', { async ping() { return 'pong'; } });
        expect(isService(s)).toBe(true);
        expect(isService({ $tag: 'entity' })).toBe(false);
        expect(isService(null)).toBe(false);
    });

    it('rejects empty name', () => {
        expect(() => service('', { async ping() { return 'pong'; } }))
            .toThrow(/name must be a non-empty string/);
    });

    it('rejects invalid name characters', () => {
        expect(() => service('my-service', { async ping() { return 'pong'; } }))
            .toThrow(/must match/);
    });

    it('rejects names starting with $ or _', () => {
        expect(() => service('$internal', { async ping() { return 'pong'; } }))
            .toThrow(/reserved/);
        expect(() => service('_private', { async ping() { return 'pong'; } }))
            .toThrow(/reserved/);
    });

    it('rejects non-function methods', () => {
        expect(() => service('bad', { notAFunction: 42 } as any))
            .toThrow(/must be a function/);
    });
});

describe('ServicePort type extraction', () => {
    it('infers port type from service def (compile-time check)', () => {
        const payments = service('payments', {
            async charge(amount: number, currency: string) {
                return { id: 'ch_1', status: 'succeeded' };
            },
            async refund(chargeId: string) {
                return { id: 're_1', status: 'succeeded' };
            },
        });
        const port: ServicePort<typeof payments> = {
            charge: async (amount: number, currency: string) => ({ id: 'x', status: 'y' }),
            refund: async (chargeId: string) => ({ id: 'x', status: 'y' }),
        };
        expect(port).toBeDefined();
    });
});

describe('override()', () => {
    const payments = service('payments', {
        async charge(amount: number, currency: string) {
            return { id: 'ch_real', status: 'succeeded' };
        },
        async refund(chargeId: string) {
            return { id: 're_real', status: 'succeeded' };
        },
    });

    it('creates a total override (all methods required)', () => {
        const testPayments = override(payments, {
            async charge(amount, currency) {
                return { id: 'ch_test', status: 'succeeded' };
            },
            async refund(chargeId) {
                return { id: 're_test', status: 'succeeded' };
            },
        });
        expect(testPayments.$tag).toBe('service-override');
        expect(testPayments.$targetName).toBe('payments');
        expect(typeof testPayments.$methods.charge).toBe('function');
        expect(typeof testPayments.$methods.refund).toBe('function');
    });

    it('creates a partial override when opt-in', () => {
        const partialOverride = override(payments, {
            async charge(amount, currency) {
                return { id: 'ch_test', status: 'succeeded' };
            },
        }, { partial: true });
        expect(partialOverride.$partial).toBe(true);
        expect(typeof partialOverride.$methods.charge).toBe('function');
        expect(partialOverride.$methods.refund).toBeUndefined();
    });

    it('rejects non-function override methods', () => {
        expect(() => override(payments, { charge: 42 } as any))
            .toThrow(/must be a function/);
    });
});
