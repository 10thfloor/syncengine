import { describe, it, expect } from 'vitest';
import {
    defineEntity,
    isEntity,
    validateEntityState,
    applyHandler,
    rebase,
    type EntityRecord,
    type EntityHandlers,
} from '../entity';
import { integer, text, real, boolean } from '../schema';

describe('defineEntity (Phase 4)', () => {
    // ── Construction ────────────────────────────────────────────────────────
    describe('construction', () => {
        it('exposes $-prefixed metadata', () => {
            const counter = defineEntity('counter', {
                state: { value: integer() },
                handlers: {
                    increment(state) {
                        return { value: state.value + 1 };
                    },
                },
            });

            expect(counter.$tag).toBe('entity');
            expect(counter.$name).toBe('counter');
            expect(Object.keys(counter.$state)).toEqual(['value']);
            expect(Object.keys(counter.$handlers)).toEqual(['increment']);
        });

        it('builds an initial state from the column shape', () => {
            const e = defineEntity('e', {
                state: {
                    n: integer(),
                    s: text(),
                    f: real(),
                    b: boolean(),
                },
                handlers: {},
            });

            expect(e.$initialState).toEqual({ n: 0, s: '', f: 0, b: false });
        });

        it('initial state for an enum text defaults to the first value', () => {
            const STATUS = ['open', 'closed'] as const;
            const e = defineEntity('e', {
                state: { status: text({ enum: STATUS }) },
                handlers: {},
            });
            expect(e.$initialState).toEqual({ status: 'open' });
        });
    });

    // ── Runtime guards ──────────────────────────────────────────────────────
    describe('construction guards', () => {
        it('rejects empty names', () => {
            expect(() =>
                defineEntity('', { state: { v: integer() }, handlers: {} }),
            ).toThrow(/non-empty/);
        });

        it('rejects $-prefixed names', () => {
            expect(() =>
                defineEntity('$bad', { state: { v: integer() }, handlers: {} }),
            ).toThrow(/\$/);
        });

        it('rejects names with invalid characters', () => {
            expect(() =>
                defineEntity('bad-name', { state: { v: integer() }, handlers: {} }),
            ).toThrow(/match/);
        });

        it('rejects $-prefixed state field names', () => {
            expect(() =>
                defineEntity('e', {
                    state: { $bad: integer() },
                    handlers: {},
                }),
            ).toThrow(/\$/);
        });

        it('rejects _-prefixed handler names (reserved for framework built-ins)', () => {
            expect(() =>
                defineEntity('e', {
                    state: { v: integer() },
                    handlers: {
                        _read(state) { return state; },
                    },
                }),
            ).toThrow(/reserved/);
        });

        it('rejects handler names with characters Restate would reject', () => {
            expect(() =>
                defineEntity('e', {
                    state: { v: integer() },
                    handlers: {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        ['bad-name' as any](state: { v: number }) { return state; },
                    },
                }),
            ).toThrow(/match/);
        });

        it('rejects non-function handlers', () => {
            expect(() =>
                defineEntity('e', {
                    state: { v: integer() },
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    handlers: { broken: 'not a function' as any },
                }),
            ).toThrow(/must be a function/);
        });

        it('isEntity() identifies the result', () => {
            const e = defineEntity('e', { state: { v: integer() }, handlers: {} });
            expect(isEntity(e)).toBe(true);
            expect(isEntity({})).toBe(false);
            expect(isEntity(null)).toBe(false);
            expect(isEntity('entity')).toBe(false);
        });
    });

    // ── Handler typing ──────────────────────────────────────────────────────
    describe('handler typing', () => {
        it('handlers can return a full state object', () => {
            const counter = defineEntity('counter', {
                state: { value: integer() },
                handlers: {
                    set(state, n: number) {
                        return { value: n };
                    },
                },
            });
            expect(counter.$handlers.set({ value: 0 }, 5)).toEqual({ value: 5 });
        });

        it('handlers can return a partial state object (typed Partial)', () => {
            const cart = defineEntity('cart', {
                state: { count: integer(), total: integer() },
                handlers: {
                    bump(state) {
                        return { count: state.count + 1 };  // partial
                    },
                },
            });
            const result = cart.$handlers.bump({ count: 0, total: 100 });
            expect(result).toEqual({ count: 1 });
        });

        it('handlers can throw to reject', () => {
            const lock = defineEntity('lock', {
                state: { holder: text() },
                handlers: {
                    acquire(state, who: string) {
                        if (state.holder && state.holder !== who) {
                            throw new Error('locked');
                        }
                        return { holder: who };
                    },
                },
            });
            expect(() => lock.$handlers.acquire({ holder: 'alice' }, 'bob')).toThrow(/locked/);
            expect(lock.$handlers.acquire({ holder: '' }, 'bob')).toEqual({ holder: 'bob' });
        });
    });

    // ── State validation ────────────────────────────────────────────────────
    describe('validateEntityState', () => {
        const shape = {
            n: integer(),
            s: text(),
            b: boolean(),
        };

        it('accepts a fully-formed record', () => {
            expect(validateEntityState(shape, { n: 1, s: 'a', b: true })).toEqual({
                n: 1,
                s: 'a',
                b: true,
            });
        });

        it('rejects a missing required column', () => {
            expect(() => validateEntityState(shape, { n: 1, s: 'a' }, 'e')).toThrow(
                /column 'b' is required/,
            );
        });

        it('rejects a wrong type', () => {
            expect(() =>
                validateEntityState(shape, { n: '1', s: 'a', b: true }, 'e'),
            ).toThrow(/expects number/);
        });

        it('enforces enum values', () => {
            const enumShape = { status: text({ enum: ['open', 'closed'] as const }) };
            expect(() =>
                validateEntityState(enumShape, { status: 'pending' }, 'e'),
            ).toThrow(/must be one of/);
            expect(validateEntityState(enumShape, { status: 'open' })).toEqual({
                status: 'open',
            });
        });

        it('integer enums work the same way', () => {
            const enumShape = { priority: integer({ enum: [1, 2, 3] as const }) };
            expect(() =>
                validateEntityState(enumShape, { priority: 9 }, 'e'),
            ).toThrow(/must be one of/);
            expect(validateEntityState(enumShape, { priority: 2 })).toEqual({
                priority: 2,
            });
        });
    });

    // ── Type-level guarantees ───────────────────────────────────────────────
    //
    // These don't run runtime assertions of their own — they exist so that
    // tsc catches regressions in EntityRecord / EntityHandlers extraction.
    describe('type-level extractors', () => {
        const cart = defineEntity('cart', {
            state: {
                items: integer(),
                total: integer(),
                status: text({ enum: ['open', 'paid'] as const }),
            },
            handlers: {
                addItem(state, qty: number) {
                    return { items: state.items + qty };
                },
                pay() {
                    return { status: 'paid' as const };
                },
            },
        });

        it('EntityRecord<typeof cart> matches the inferred shape', () => {
            // Compile-time only — the runtime check just exercises the field shapes.
            const sample: EntityRecord<typeof cart> = {
                items: 0,
                total: 0,
                status: 'open',
            };
            expect(sample.items).toBe(0);
        });

        it('EntityHandlers<typeof cart> exposes the handler map', () => {
            const handlers: EntityHandlers<typeof cart> = cart.$handlers;
            expect(Object.keys(handlers)).toEqual(['addItem', 'pay']);
        });
    });

    // ── applyHandler (moved to core from entity-runtime) ────────────────────
    describe('applyHandler', () => {
        const counter = defineEntity('counter', {
            state: { value: integer() },
            handlers: {
                increment(state, by: number) {
                    return { value: state.value + by };
                },
                reset() {
                    return { value: 0 };
                },
                bad() {
                    return { value: 'oops' as unknown as number };
                },
            },
        });

        it('runs against null state by seeding initial state', () => {
            expect(applyHandler(counter, 'increment', null, [3])).toEqual({ value: 3 });
        });

        it('runs against an existing state', () => {
            expect(applyHandler(counter, 'increment', { value: 5 }, [10])).toEqual({ value: 15 });
        });

        it('throws on unknown handler name', () => {
            expect(() => applyHandler(counter, 'nope', { value: 0 }, [])).toThrow(
                /no handler named 'nope'/,
            );
        });

        it('wraps user-thrown errors with entity context', () => {
            const lock = defineEntity('lock', {
                state: { holder: text() },
                handlers: {
                    acquire(state, who: string) {
                        if (state.holder && state.holder !== who) throw new Error('locked');
                        return { holder: who };
                    },
                },
            });
            expect(() => applyHandler(lock, 'acquire', { holder: 'alice' }, ['bob'])).toThrow(
                /'lock' handler 'acquire' rejected: locked/,
            );
        });

        it('rejects handler outputs that fail state validation', () => {
            expect(() => applyHandler(counter, 'bad', { value: 0 }, [])).toThrow(
                /column 'value' expects number/,
            );
        });
    });

    // ── rebase (latency compensation) ───────────────────────────────────────
    describe('rebase', () => {
        const counter = defineEntity('counter', {
            state: { value: integer() },
            handlers: {
                increment(state, by: number) {
                    return { value: state.value + by };
                },
                mustBePositive(state) {
                    if (state.value <= 0) throw new Error('non-positive');
                    return { value: state.value * 2 };
                },
            },
        });

        it('returns null state when confirmed is null', () => {
            const result = rebase(counter, null, []);
            expect(result.state).toBeNull();
            expect(result.failedIds).toEqual([]);
        });

        it('returns the confirmed state when pending is empty', () => {
            const result = rebase(counter, { value: 42 }, []);
            expect(result.state).toEqual({ value: 42 });
            expect(result.failedIds).toEqual([]);
        });

        it('folds a single pending action over the confirmed base', () => {
            const result = rebase(counter, { value: 10 }, [
                { id: 1, handlerName: 'increment', args: [5] },
            ]);
            expect(result.state).toEqual({ value: 15 });
            expect(result.failedIds).toEqual([]);
        });

        it('folds multiple pending actions in order', () => {
            const result = rebase(counter, { value: 0 }, [
                { id: 1, handlerName: 'increment', args: [1] },
                { id: 2, handlerName: 'increment', args: [2] },
                { id: 3, handlerName: 'increment', args: [3] },
            ]);
            expect(result.state).toEqual({ value: 6 });
            expect(result.failedIds).toEqual([]);
        });

        it('re-running on a different confirmed produces the right answer (concurrent write case)', () => {
            // My original pending: [+5]. If confirmed is 10 → optimistic is 15.
            // A remote client also did +3 → new confirmed is 13.
            // Rebasing my pending on the new confirmed should give 18.
            const pending = [{ id: 1, handlerName: 'increment', args: [5] }];
            const before = rebase(counter, { value: 10 }, pending);
            expect(before.state).toEqual({ value: 15 });
            const after = rebase(counter, { value: 13 }, pending);
            expect(after.state).toEqual({ value: 18 });
        });

        it('drops actions that throw during rebase and reports their stable ids', () => {
            // mustBePositive throws on non-positive state. If the confirmed
            // state is 5 → mustBePositive → 10 (ok). If confirmed is 0 →
            // mustBePositive throws → drop from chain → subsequent actions
            // continue from the un-doubled state.
            const pending = [
                { id: 42, handlerName: 'mustBePositive', args: [] },
                { id: 43, handlerName: 'increment', args: [7] },
            ];
            const ok = rebase(counter, { value: 5 }, pending);
            expect(ok.state).toEqual({ value: 17 }); // (5*2)+7
            expect(ok.failedIds).toEqual([]);

            const bad = rebase(counter, { value: 0 }, pending);
            expect(bad.state).toEqual({ value: 7 }); // mustBePositive dropped, then 0+7
            // Failure reported by the action's stable id, not its array index.
            expect(bad.failedIds).toEqual([42]);
        });

        it('pending actions are immutable inputs — rebase does not mutate them', () => {
            const pending = [
                { id: 1, handlerName: 'increment', args: [1] },
                { id: 2, handlerName: 'increment', args: [2] },
            ] as const;
            const result1 = rebase(counter, { value: 10 }, pending);
            const result2 = rebase(counter, { value: 100 }, pending);
            expect(result1.state).toEqual({ value: 13 });
            expect(result2.state).toEqual({ value: 103 });
        });

        it('partial-state handler returns still merge into confirmed', () => {
            // addItem returns { items } (partial), not a full state.
            const cart = defineEntity('cart', {
                state: { items: integer(), total: integer() },
                handlers: {
                    addItem(state, qty: number) {
                        return { items: state.items + qty };
                    },
                },
            });
            const result = rebase(cart, { items: 0, total: 100 }, [
                { id: 1, handlerName: 'addItem', args: [3] },
            ]);
            expect(result.state).toEqual({ items: 3, total: 100 });
        });
    });
});
