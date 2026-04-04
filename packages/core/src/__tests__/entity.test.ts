import { describe, it, expect } from 'vitest';
import {
    defineEntity,
    isEntity,
    validateEntityState,
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
});
