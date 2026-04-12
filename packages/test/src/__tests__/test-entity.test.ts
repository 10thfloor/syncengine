import { describe, it, expect } from 'vitest';
import { entity, integer, text, real, emit } from '@syncengine/core';
import { testEntity } from '../test-entity.js';

// -- Minimal test entities (mirrors the demo patterns) -----------------------

const counter = entity('counter', {
    state: { value: integer() },
    handlers: {
        increment(state) { return { ...state, value: state.value + 1 }; },
        add(state, amount: number) { return { ...state, value: state.value + amount }; },
        reset(state) { return { ...state, value: 0 }; },
    },
});

const STATUSES = ['draft', 'placed', 'shipped'] as const;
const ledger = entity('ledger', {
    state: {
        status: text({ enum: STATUSES }),
        total: real(),
    },
    handlers: {
        place(state, amount: number) {
            if (state.status !== 'draft') throw new Error('Already placed');
            return emit(
                { ...state, status: 'placed' as const, total: amount },
                { table: 'orders', record: { amount, status: 'placed' } },
            );
        },
        ship(state) {
            if (state.status !== 'placed') throw new Error('Not placed');
            return { ...state, status: 'shipped' as const };
        },
    },
});

// -- Tests -------------------------------------------------------------------

describe('testEntity', () => {
    it('initializes with entity defaults', () => {
        const t = testEntity(counter);
        expect(t.state.value).toBe(0);
    });

    it('initializes with custom state', () => {
        const t = testEntity(counter, { value: 42 });
        expect(t.state.value).toBe(42);
    });

    it('mutates state through handlers', () => {
        const t = testEntity(counter);
        t.call('increment');
        expect(t.state.value).toBe(1);
        t.call('add', 10);
        expect(t.state.value).toBe(11);
        t.call('reset');
        expect(t.state.value).toBe(0);
    });

    it('throws on handler errors', () => {
        const t = testEntity(ledger);
        t.call('place', 100);
        expect(() => t.call('place', 200)).toThrow('Already placed');
    });

    it('collects emitted records', () => {
        const t = testEntity(ledger);
        t.call('place', 79);
        expect(t.emits).toHaveLength(1);
        expect(t.emits[0].table).toBe('orders');
        expect(t.emits[0].record.amount).toBe(79);
        expect(t.emits[0].record.status).toBe('placed');
    });

    it('tracks state across emit handlers', () => {
        const t = testEntity(ledger);
        t.call('place', 50);
        expect(t.state.status).toBe('placed');
        expect(t.state.total).toBe(50);
        t.call('ship');
        expect(t.state.status).toBe('shipped');
    });

    it('clearEmits resets the emits array', () => {
        const t = testEntity(ledger);
        t.call('place', 100);
        expect(t.emits).toHaveLength(1);
        t.clearEmits();
        expect(t.emits).toHaveLength(0);
    });

    it('accumulates emits across multiple calls', () => {
        const t = testEntity(ledger);
        t.call('place', 100);
        t.call('ship');
        // ship doesn't emit, so still 1
        expect(t.emits).toHaveLength(1);
    });

    it('throws on unknown handler name', () => {
        const t = testEntity(counter);
        expect(() => t.call('nonexistent')).toThrow("no handler named 'nonexistent'");
    });
});
