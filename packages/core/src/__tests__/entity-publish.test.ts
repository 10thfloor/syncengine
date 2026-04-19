import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { bus } from '../bus';
import {
    emit, publish, insert, trigger,
    extractEmits, extractTriggers, extractPublishes,
    PUBLISH_KEY,
    defineEntity,
} from '../entity';
import { table, text, integer, id } from '../schema';

const orderEvents = bus('events', {
    schema: z.object({ orderId: z.string(), at: z.number() }),
});

const notes = table('notes', { id: id(), body: text() });

describe('publish() effect', () => {
    it('returns a typed effect declaration', () => {
        const eff = publish(orderEvents, { orderId: '1', at: 0 });
        expect(eff.$effect).toBe('publish');
        expect(eff.bus.$name).toBe('events');
        expect(eff.payload).toEqual({ orderId: '1', at: 0 });
    });

    it('validates payload against the bus schema at call time', () => {
        // @ts-expect-error — missing required field
        expect(() => publish(orderEvents, { orderId: '1' })).toThrow(/invalid bus payload/i);
    });
});

describe('emit({ state, effects }) with publish()', () => {
    it('attaches publishes via PUBLISH_KEY symbol', () => {
        const result = emit({
            state: { n: 1 },
            effects: [publish(orderEvents, { orderId: '1', at: 0 })],
        });
        const publishes = extractPublishes(result);
        expect(publishes).toBeDefined();
        expect(publishes).toHaveLength(1);
        expect(publishes![0].bus.$name).toBe('events');
        expect(publishes![0].payload).toEqual({ orderId: '1', at: 0 });
    });

    it('keeps PUBLISH_KEY non-enumerable so spreads drop it', () => {
        const result = emit({
            state: { n: 1 },
            effects: [publish(orderEvents, { orderId: '1', at: 0 })],
        });
        const spread = { ...result };
        expect(extractPublishes(spread as Record<string, unknown>)).toBeUndefined();
        expect(extractPublishes(result as Record<string, unknown>)).toHaveLength(1);
    });

    it('coexists with insert() and trigger() in the same emit call', () => {
        const wf = { $tag: 'workflow' as const, $name: 'processPayment' };
        const result = emit({
            state: { n: 1 },
            effects: [
                insert(notes, { id: 1, body: 'hello' }),
                trigger(wf, { total: 100 }),
                publish(orderEvents, { orderId: '1', at: 0 }),
            ],
        });
        expect(extractEmits(result)).toHaveLength(1);
        expect(extractTriggers(result)).toHaveLength(1);
        expect(extractPublishes(result)).toHaveLength(1);
    });

    it('entity handler can return emit({ publish }) via defineEntity', () => {
        const counter = defineEntity('counter', {
            state: { n: integer() },
            handlers: {
                bump(state) {
                    return emit({
                        state: { ...state, n: state.n + 1 },
                        effects: [publish(orderEvents, { orderId: String(state.n + 1), at: 0 })],
                    }) as unknown as typeof state;
                },
            },
        });
        const out = counter.$handlers.bump({ n: 1 });
        expect(out.n).toBe(2);
        const publishes = extractPublishes(out as unknown as Record<string, unknown>);
        expect(publishes).toHaveLength(1);
        expect(publishes![0].payload).toEqual({ orderId: '2', at: 0 });
    });
});

describe('PUBLISH_KEY', () => {
    it('is a process-wide registered symbol (survives module reload)', () => {
        expect(PUBLISH_KEY).toBe(Symbol.for('syncengine.publish'));
    });
});
