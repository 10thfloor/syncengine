import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { bus } from '@syncengine/core';
import type { BusDispatcherConfig } from '@syncengine/gateway-core';
import { defineWorkflow, type WorkflowDef } from '../workflow';
import { on } from '../bus-on';
import {
    BusManager,
    type DispatcherFactory,
    type DispatcherHandle,
} from '../bus-manager';

const orderEvents = bus('orderEvents', {
    schema: z.object({ orderId: z.string(), event: z.string() }),
});

const shipOnPay = defineWorkflow(
    'shipOnPay',
    { on: on(orderEvents) },
    async () => { /* noop */ },
);

const auditOnEvent = defineWorkflow(
    'auditOnEvent',
    { on: on(orderEvents) },
    async () => { /* noop */ },
);

const plainWorkflow = defineWorkflow(
    'plain',
    async () => { /* noop */ },
);

type StubCall = { workspaceId: string; subscriberName: string };

function stubFactory(options: { startThrowsFor?: string } = {}): {
    factory: DispatcherFactory;
    starts: StubCall[];
    stops: StubCall[];
    configs: BusDispatcherConfig[];
} {
    const starts: StubCall[] = [];
    const stops: StubCall[] = [];
    const configs: BusDispatcherConfig[] = [];
    const factory: DispatcherFactory = (cfg) => {
        configs.push(cfg);
        const handle: DispatcherHandle = {
            async start() {
                if (options.startThrowsFor && cfg.subscriberName === options.startThrowsFor) {
                    throw new Error(`boom: ${cfg.subscriberName}`);
                }
                starts.push({ workspaceId: cfg.workspaceId, subscriberName: cfg.subscriberName });
            },
            async stop() {
                stops.push({ workspaceId: cfg.workspaceId, subscriberName: cfg.subscriberName });
            },
        };
        return handle;
    };
    return { factory, starts, stops, configs };
}

function build(
    // WorkflowDef's TInput is contravariant in $handler's parameter, so
    // a list with heterogeneous inputs can't be widened to WorkflowDef[]
    // without a cast. Take `unknown` and cast once here.
    workflows: readonly unknown[],
    initial: string[] = [],
    extras: { startThrowsFor?: string } = {},
) {
    const stub = stubFactory(extras);
    const instance = new BusManager({
        natsUrl: 'nats://test',
        restateUrl: 'http://test',
        workflows: workflows as readonly WorkflowDef[],
        dispatcherFactory: stub.factory,
        initialWorkspaceIds: initial,
        installSignalHandlers: false,
    });
    return { ...stub, instance };
}

describe('BusManager', () => {
    it('spawns one dispatcher per (workspace × subscriber) on startup', async () => {
        const { instance, starts } = build([shipOnPay], ['ws1', 'ws2']);
        await instance.start();
        const pairs = starts
            .map((s) => `${s.workspaceId}/${s.subscriberName}`)
            .sort();
        expect(pairs).toEqual(['ws1/shipOnPay', 'ws2/shipOnPay']);
    });

    it('fan-out: multiple subscribers on the same bus each get a dispatcher per workspace', async () => {
        const { instance, starts } = build([shipOnPay, auditOnEvent], ['ws1']);
        await instance.start();
        const subs = starts.map((s) => s.subscriberName).sort();
        expect(subs).toEqual(['auditOnEvent', 'shipOnPay']);
    });

    it('one dispatcher start() failing does not block the others', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { instance, starts } = build(
            [shipOnPay, auditOnEvent],
            ['ws1'],
            { startThrowsFor: 'shipOnPay' },
        );
        await instance.start();
        expect(starts.map((s) => s.subscriberName)).toEqual(['auditOnEvent']);
        expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/shipOnPay.+failed to start/),
        );
        warn.mockRestore();
    });

    it('stop() drains every dispatcher', async () => {
        const { instance, stops } = build([shipOnPay, auditOnEvent], ['ws1', 'ws2']);
        await instance.start();
        await instance.stop();
        expect(stops).toHaveLength(4);
    });

    it('onWorkspaceProvisioned spawns dispatchers for a new workspace', async () => {
        const { instance, starts } = build([shipOnPay], ['ws1']);
        await instance.start();
        starts.length = 0;
        await instance.onWorkspaceProvisioned('ws2');
        expect(starts).toEqual([{ workspaceId: 'ws2', subscriberName: 'shipOnPay' }]);
    });

    it('spawn is idempotent for the same (workspace × subscriber) pair', async () => {
        const { instance, starts } = build([shipOnPay], ['ws1']);
        await instance.start();
        await instance.onWorkspaceProvisioned('ws1');
        await instance.onWorkspaceProvisioned('ws1');
        expect(starts).toHaveLength(1);
    });

    it('ignores non-subscriber workflows', async () => {
        const { instance, starts } = build([plainWorkflow], ['ws1']);
        await instance.start();
        expect(starts).toEqual([]);
    });

    it('dispatcher config carries bus name + dlq name + filter predicate', async () => {
        const filteredSub = defineWorkflow(
            'filtered',
            {
                on: on(orderEvents).where((e) => e.event === 'paid'),
            },
            async () => { /* noop */ },
        );
        const { instance, configs } = build([filteredSub], ['ws1']);
        await instance.start();
        expect(configs).toHaveLength(1);
        const cfg = configs[0]!;
        expect(cfg.workspaceId).toBe('ws1');
        expect(cfg.busName).toBe('orderEvents');
        expect(cfg.dlqBusName).toBe('orderEvents.dlq');
        expect(cfg.filterPredicate).toBeDefined();
        expect(cfg.filterPredicate!({ orderId: '1', event: 'paid' })).toBe(true);
        expect(cfg.filterPredicate!({ orderId: '1', event: 'placed' })).toBe(false);
    });

    it('stop() after failed start does not blow up', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { instance } = build(
            [shipOnPay],
            ['ws1'],
            { startThrowsFor: 'shipOnPay' },
        );
        await instance.start();
        await expect(instance.stop()).resolves.toBeUndefined();
        warn.mockRestore();
    });

    it('cursor defaults to { kind: "latest" } when subscription has no .from', async () => {
        const { instance, configs } = build([shipOnPay], ['ws1']);
        await instance.start();
        expect(configs[0]!.cursor).toEqual({ kind: 'latest' });
    });
});
