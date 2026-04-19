import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { bus, setBusPublisher } from '@syncengine/core';
import {
    busContextStorage, runInBusContext,
    installBusPublisher, uninstallBusPublisher,
} from '../bus-context';

afterEach(() => {
    uninstallBusPublisher();
});

describe('busContextStorage + runInBusContext', () => {
    it('returns undefined outside any frame', () => {
        expect(busContextStorage.getStore()).toBeUndefined();
    });

    it('isolates concurrent invocations by ALS semantics', async () => {
        const nc1 = { publish: vi.fn() } as unknown as Parameters<typeof runInBusContext>[0]['nc'];
        const nc2 = { publish: vi.fn() } as unknown as Parameters<typeof runInBusContext>[0]['nc'];

        await Promise.all([
            runInBusContext({ workspaceId: 'w1', nc: nc1 }, async () => {
                await new Promise<void>((r) => setTimeout(r, 5));
                const bc = busContextStorage.getStore();
                expect(bc?.workspaceId).toBe('w1');
            }),
            runInBusContext({ workspaceId: 'w2', nc: nc2 }, async () => {
                await new Promise<void>((r) => setTimeout(r, 5));
                const bc = busContextStorage.getStore();
                expect(bc?.workspaceId).toBe('w2');
            }),
        ]);
    });

    it('carries optional requestId', async () => {
        const nc = { publish: vi.fn() } as unknown as Parameters<typeof runInBusContext>[0]['nc'];
        await runInBusContext({ workspaceId: 'w1', nc, requestId: 'req-abc' }, async () => {
            expect(busContextStorage.getStore()?.requestId).toBe('req-abc');
        });
    });
});

describe('installBusPublisher → bus.publish end-to-end', () => {
    const schema = z.object({ orderId: z.string(), at: z.number() });

    it('publishes to ws.<wsId>.bus.<name> using the ALS-carried NC', async () => {
        const nc = {
            publish: vi.fn<[string, string, unknown?], void>(),
        };
        installBusPublisher();

        const b = bus('orderEvents', { schema });
        const fakeCtx = { run: async <T,>(_n: string, fn: () => Promise<T>) => fn() };

        await runInBusContext(
            { workspaceId: 'ws1', nc: nc as unknown as Parameters<typeof runInBusContext>[0]['nc'] },
            async () => {
                await b.publish(fakeCtx, { orderId: '1', at: 0 });
            },
        );

        expect(nc.publish).toHaveBeenCalledTimes(1);
        const call = nc.publish.mock.calls[0]!;
        expect(call[0]).toBe('ws.ws1.bus.orderEvents');
        expect(JSON.parse(call[1]!)).toEqual({ orderId: '1', at: 0 });
    });

    it('fails loudly when bus.publish is called outside any ALS frame', async () => {
        installBusPublisher();
        const b = bus('orderEvents', { schema });
        const fakeCtx = { run: async <T,>(_n: string, fn: () => Promise<T>) => fn() };
        await expect(b.publish(fakeCtx, { orderId: '1', at: 0 })).rejects.toThrow(/BusContext|outside/i);
    });

    it('uninstallBusPublisher detaches the publisher', async () => {
        installBusPublisher();
        setBusPublisher(null); // simulate re-entry from another pathway
        // Confirm we can reinstall cleanly.
        installBusPublisher();
        uninstallBusPublisher();
        const b = bus('orderEvents', { schema });
        const fakeCtx = { run: async <T,>(_n: string, fn: () => Promise<T>) => fn() };
        await expect(b.publish(fakeCtx, { orderId: '1', at: 0 })).rejects.toThrow();
    });
});
