import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { bus, entity, text, emit, publish, BusMode, override, isBusOverride, serviceOverride, service } from '@syncengine/core';
import { createBusTestHarness } from '../test/bus-harness';

const schema = z.object({
    orderId: z.string(),
    total: z.number(),
});
const orderEvents = bus('orderEvents', { schema });

describe('createBusTestHarness', () => {
    let harness = createBusTestHarness();

    afterEach(() => {
        harness.dispose();
        harness = createBusTestHarness();
    });

    it('captures imperative bus.publish(ctx, payload) calls', async () => {
        await orderEvents.publish(harness.ctx(), { orderId: 'O1', total: 10 });
        await orderEvents.publish(harness.ctx(), { orderId: 'O2', total: 42 });

        const events = harness.publishedOn(orderEvents);
        expect(events).toHaveLength(2);
        expect(events[0]).toEqual({ orderId: 'O1', total: 10 });
        expect(events[1]).toEqual({ orderId: 'O2', total: 42 });
    });

    it('rejects publish with schema-invalid payload', async () => {
        await expect(
            orderEvents.publish(harness.ctx(), { orderId: 'O3' } as never),
        ).rejects.toThrow(/invalid bus payload/);
    });

    it('clear() drains the buffer without re-installing the publisher', async () => {
        await orderEvents.publish(harness.ctx(), { orderId: 'O1', total: 10 });
        harness.clear();
        await orderEvents.publish(harness.ctx(), { orderId: 'O2', total: 20 });
        expect(harness.publishedOn(orderEvents)).toEqual([
            { orderId: 'O2', total: 20 },
        ]);
    });

    it('all() shows cross-bus chronology', async () => {
        const other = bus('otherEvents', { schema });
        await orderEvents.publish(harness.ctx(), { orderId: 'O1', total: 10 });
        await other.publish(harness.ctx(), { orderId: 'O2', total: 20 });
        const all = harness.all();
        expect(all.map((e) => e.bus)).toEqual(['orderEvents', 'otherEvents']);
    });

    describe('capturePublishEffects — declarative path', () => {
        const cart = entity('cart', {
            state: {
                status: text({ enum: ['open', 'paid'] as const }),
                total: text(),
            },
            transitions: {
                open: ['paid'],
                paid: [],
            },
            handlers: {
                pay(state, req: { orderId: string }) {
                    return emit({
                        state: { ...state, status: 'paid' as const },
                        effects: [
                            publish(orderEvents, { orderId: req.orderId, total: 99 }),
                        ],
                    });
                },
            },
        });

        it('pulls publish() effects off an entity handler return', () => {
            const result = cart.$handlers.pay(
                { status: 'open', total: '0' },
                { orderId: 'Z1' },
            );
            const captured = harness.capturePublishEffects(result);
            expect(captured).toHaveLength(1);
            expect(captured[0]).toMatchObject({
                bus: 'orderEvents',
                payload: { orderId: 'Z1', total: 99 },
            });
        });

        it('returns empty for a handler that published nothing', () => {
            const result = {
                status: 'open' as const,
                total: '0',
            };
            expect(harness.capturePublishEffects(result)).toEqual([]);
        });
    });
});

describe('BusMode + override(bus)', () => {
    it('BusMode.nats / .inMemory are tagged factories', () => {
        expect(BusMode.nats()).toEqual({ kind: 'nats' });
        expect(BusMode.inMemory()).toEqual({ kind: 'inMemory' });
    });

    it('bus() stores mode — defaults to nats, respects explicit inMemory', () => {
        const b1 = bus('b1', { schema });
        expect(b1.$mode).toEqual({ kind: 'nats' });

        const b2 = bus('b2', { schema, mode: BusMode.inMemory() });
        expect(b2.$mode).toEqual({ kind: 'inMemory' });
    });

    it('a bus DLQ inherits the parent mode', () => {
        const inMem = bus('inMem', { schema, mode: BusMode.inMemory() });
        expect(inMem.dlq.$mode).toEqual({ kind: 'inMemory' });
    });

    it('override(bus, { mode }) produces a BusOverride', () => {
        const ovr = override(orderEvents, { mode: BusMode.inMemory() });
        expect(isBusOverride(ovr)).toBe(true);
        expect(ovr.$tag).toBe('bus-override');
        expect(ovr.$targetName).toBe('orderEvents');
        expect(ovr.mode).toEqual({ kind: 'inMemory' });
    });

    it('override(service, {...}) still works — polymorphic dispatch', () => {
        const payments = service('payments', {
            async charge(_amount: number): Promise<{ id: string }> {
                return { id: 'ch_prod' };
            },
        });
        const ovr = override(payments, {
            async charge(_amount: number) {
                return { id: 'ch_test' };
            },
        });
        expect(ovr.$tag).toBe('service-override');
        expect(ovr.$targetName).toBe('payments');

        // serviceOverride (narrow form) is also exposed.
        const narrow = serviceOverride(payments, {
            async charge(_amount: number) {
                return { id: 'ch_narrow' };
            },
        });
        expect(narrow.$tag).toBe('service-override');
    });

    it('override() rejects non-ServiceDef, non-BusRef targets', () => {
        expect(() => override({ $tag: 'nope' } as never, { mode: BusMode.nats() })).toThrow(
            /ServiceDef or BusRef/,
        );
    });
});
