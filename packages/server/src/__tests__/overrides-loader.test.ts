import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { bus, BusMode, override, service } from '@syncengine/core';
import {
    extractOverrides,
    loadConfigOverrides,
    busOverridesToModeOf,
} from '../overrides-loader';

const payments = service('payments', {
    async charge(_amount: number): Promise<{ id: string }> {
        return { id: 'ch_prod' };
    },
});
const schema = z.object({ k: z.string() });
const orderEvents = bus('orderEvents', { schema });

describe('extractOverrides — shape normaliser', () => {
    it('accepts a single service override as default export', () => {
        const mod = { default: override(payments, {
            async charge(_amount: number) { return { id: 'ch_test' } as never; },
        }) };
        const { serviceOverrides, busOverrides } = extractOverrides(mod);
        expect(serviceOverrides).toHaveLength(1);
        expect(busOverrides).toHaveLength(0);
    });

    it('accepts a single bus override as default export', () => {
        const mod = { default: override(orderEvents, { mode: BusMode.inMemory() }) };
        const { serviceOverrides, busOverrides } = extractOverrides(mod);
        expect(serviceOverrides).toHaveLength(0);
        expect(busOverrides).toHaveLength(1);
        expect(busOverrides[0]!.$targetName).toBe('orderEvents');
    });

    it('accepts a mixed array — services and buses split by $tag', () => {
        const mod = {
            default: [
                override(payments, { async charge(_a: number) { return { id: 'ch_test' } as never; } }),
                override(orderEvents, { mode: BusMode.inMemory() }),
            ],
        };
        const { serviceOverrides, busOverrides } = extractOverrides(mod);
        expect(serviceOverrides).toHaveLength(1);
        expect(busOverrides).toHaveLength(1);
    });

    it('accepts named exports alongside default', () => {
        const mod = {
            default: override(payments, { async charge(_a: number) { return { id: 'def' } as never; } }),
            busOverride: override(orderEvents, { mode: BusMode.inMemory() }),
        };
        const { serviceOverrides, busOverrides } = extractOverrides(mod);
        expect(serviceOverrides).toHaveLength(1);
        expect(busOverrides).toHaveLength(1);
    });

    it('ignores unrecognised values — helpers and constants co-exist', () => {
        const mod = {
            default: [override(payments, { async charge(_a: number) { return { id: 'ok' } as never; } })],
            SOME_CONSTANT: 42,
            helperFn: () => 'hello',
        };
        const { serviceOverrides } = extractOverrides(mod);
        expect(serviceOverrides).toHaveLength(1);
    });

    it('handles null / undefined payloads gracefully', () => {
        expect(extractOverrides(null).serviceOverrides).toHaveLength(0);
        expect(extractOverrides(undefined).busOverrides).toHaveLength(0);
    });
});

describe('loadConfigOverrides — calls config.services.overrides()', () => {
    it('returns empty when no overrides function is defined', async () => {
        const out = await loadConfigOverrides({ workspaces: { resolve: () => 'ws' } });
        expect(out.serviceOverrides).toEqual([]);
        expect(out.busOverrides).toEqual([]);
    });

    it('awaits the import function and extracts', async () => {
        const config = {
            workspaces: { resolve: () => 'ws' },
            services: {
                overrides: async () => ({
                    default: [
                        override(payments, {
                            async charge(_a: number) { return { id: 'test' } as never; },
                        }),
                        override(orderEvents, { mode: BusMode.inMemory() }),
                    ],
                }),
            },
        };
        const out = await loadConfigOverrides(config);
        expect(out.serviceOverrides).toHaveLength(1);
        expect(out.busOverrides).toHaveLength(1);
    });
});

describe('busOverridesToModeOf — resolver factory', () => {
    it('empty overrides → always null (use default)', () => {
        const modeOf = busOverridesToModeOf([]);
        expect(modeOf('anything')).toBeNull();
    });

    it('maps target name → configured mode', () => {
        const modeOf = busOverridesToModeOf([
            override(orderEvents, { mode: BusMode.inMemory() }),
        ]);
        expect(modeOf('orderEvents')).toBe('inMemory');
        expect(modeOf('otherBus')).toBeNull();
    });

    it('ignores overrides that don\'t set a mode', () => {
        const modeOf = busOverridesToModeOf([
            { $tag: 'bus-override', $targetName: 'orderEvents' } as never,
        ]);
        expect(modeOf('orderEvents')).toBeNull();
    });
});
