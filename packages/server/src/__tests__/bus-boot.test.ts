import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { bus, BusMode } from '@syncengine/core';
import { defineWorkflow, on } from '../index';
import { bootBusRuntime } from '../bus-boot';
import { uninstallBusPublisher } from '../bus-context';

const mockCtx = {
    run: async <T>(_n: string, fn: () => Promise<T>): Promise<T> => fn(),
};

const schema = z.object({
    orderId: z.string(),
    total: z.number(),
});

describe('bootBusRuntime — per-bus mode routing', () => {
    afterEach(() => {
        uninstallBusPublisher();
    });

    it('pure-inMemory app skips NATS entirely', async () => {
        const testEvents = bus('testEvents', { schema, mode: BusMode.inMemory() });
        const seen: unknown[] = [];
        const sub = defineWorkflow(
            'captureTestEvents',
            { on: on(testEvents) },
            async (_ctx, event) => {
                seen.push(event);
            },
        );

        const handle = await bootBusRuntime({
            workflows: [sub as never],
            buses: [testEvents],
        });

        expect(handle).not.toBeNull();
        expect(handle!.nc).toBeNull();         // no NATS connection attempted
        expect(handle!.manager).toBeNull();    // no BusManager spawned
        expect(handle!.inMemoryDriver).not.toBeNull();

        // Publish routes through the driver; subscriber fires inline.
        await testEvents.publish(
            mockCtx,
            { orderId: 'O1', total: 10 },
        );
        expect(seen).toEqual([{ orderId: 'O1', total: 10 }]);
    });

    it('modeOf override wins over declared $mode', async () => {
        // Bus declared as NATS in code; flipped to inMemory via modeOf.
        // Same shape as a config-loaded BusOverride wiring.
        const productionBus = bus('productionBus', { schema });
        expect(productionBus.$mode.kind).toBe('nats');

        const seen: unknown[] = [];
        const sub = defineWorkflow(
            'captureProd',
            { on: on(productionBus) },
            async (_ctx, event) => {
                seen.push(event);
            },
        );

        const handle = await bootBusRuntime({
            workflows: [sub as never],
            buses: [productionBus],
            modeOf: (name) => (name === 'productionBus' ? 'inMemory' : 'nats'),
        });

        expect(handle!.nc).toBeNull();
        expect(handle!.inMemoryDriver).not.toBeNull();

        await productionBus.publish(
            mockCtx,
            { orderId: 'O2', total: 20 },
        );
        expect(seen).toEqual([{ orderId: 'O2', total: 20 }]);
    });

    it('no subscribers + no buses → null handle', async () => {
        const handle = await bootBusRuntime({ workflows: [], buses: [] });
        expect(handle).toBeNull();
    });

    it('in-memory bus DLQ inherits mode — DLQ subscribers fire through driver', async () => {
        const memBus = bus('memBus', { schema, mode: BusMode.inMemory() });
        const deadSeen: unknown[] = [];

        const dlqSub = defineWorkflow(
            'captureDlq',
            { on: on(memBus.dlq) },
            async (_ctx, dead) => {
                deadSeen.push(dead);
            },
        );

        const handle = await bootBusRuntime({
            workflows: [dlqSub as never],
            buses: [memBus],
        });
        expect(handle!.inMemoryDriver).not.toBeNull();

        // Publish directly on the DLQ bus — modeOf should resolve it to inMemory.
        await memBus.dlq.publish(
            mockCtx,
            {
                original: { orderId: 'X', total: 0 },
                error: { message: 'fail' },
                attempts: 1,
                firstAttemptAt: 0,
                lastAttemptAt: 0,
                workflow: 'upstream',
            },
        );
        expect(deadSeen).toHaveLength(1);
    });
});
