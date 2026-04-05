import { describe, it, expect } from 'vitest';
import {
    table, id, integer, real, text, boolean,
    view, sum, count, avg, max, min,
    extractMergeConfig, isTable, isView,
} from '../schema';

describe('Schema DSL (Phase 2.5)', () => {
    // ── Table construction ──────────────────────────────────────────
    describe('table()', () => {
        it('exposes $-prefixed metadata', () => {
            const t = table('users', {
                id: id(),
                name: text(),
            });
            expect(t.$tag).toBe('table');
            expect(t.$name).toBe('users');
            expect(t.$idKey).toBe('id');
            expect(Object.keys(t.$columns)).toEqual(['id', 'name']);
        });

        it('exposes each column as a ColumnRef at the top level', () => {
            const t = table('users', {
                id: id(),
                name: text(),
            });
            expect(t.name.$tag).toBe('col');
            expect(t.name.$table).toBe('users');
            expect(t.name.$name).toBe('name');
            expect(t.id.$table).toBe('users');
            expect(t.id.$name).toBe('id');
        });

        it('defaults non-PK columns to merge: lww', () => {
            const t = table('posts', {
                id: id(),
                title: text(),
                likes: integer(),
                priority: real(),
                published: boolean(),
            });
            expect(t.$columns.title.merge).toBe('lww');
            expect(t.$columns.likes.merge).toBe('lww');
            expect(t.$columns.priority.merge).toBe('lww');
            expect(t.$columns.published.merge).toBe('lww');
        });

        it('PK columns have merge: null', () => {
            const t = table('users', { id: id(), name: text() });
            expect(t.$columns.id.merge).toBeNull();
        });

        it('allows explicit opt-out with merge: false', () => {
            const t = table('users', {
                id: id(),
                name: text({ merge: false }),
            });
            expect(t.$columns.name.merge).toBeNull();
        });

        it('allows non-default merge strategies', () => {
            const t = table('metrics', {
                id: id(),
                total: integer({ merge: 'add' }),
                tags: text({ merge: 'set_union' }),
            });
            expect(t.$columns.total.merge).toBe('add');
            expect(t.$columns.tags.merge).toBe('set_union');
        });

        it('throws on column name starting with $', () => {
            expect(() =>
                table('users', {
                    id: id(),
                    $name: text(),
                }),
            ).toThrow(/\$/);
        });

        it('throws when no primary key is declared', () => {
            expect(() =>
                table('nopk', {
                    name: text(),
                }),
            ).toThrow(/primary key/);
        });

        it('is identified by isTable()', () => {
            const t = table('t', { id: id() });
            expect(isTable(t)).toBe(true);
            expect(isTable({})).toBe(false);
            expect(isTable(null)).toBe(false);
        });
    });

    // ── Enum narrowing ──────────────────────────────────────────────
    describe('text({ enum }) / integer({ enum })', () => {
        it('text enum flows through column metadata', () => {
            const CATEGORIES = ['A', 'B', 'C'] as const;
            const t = table('items', {
                id: id(),
                category: text({ enum: CATEGORIES }),
            });
            expect(t.$columns.category.enum).toEqual(CATEGORIES);
            expect(t.$columns.category.sqlType).toBe('TEXT');
        });

        it('integer enum flows through column metadata', () => {
            const PRIORITIES = [1, 2, 3] as const;
            const t = table('tasks', {
                id: id(),
                priority: integer({ enum: PRIORITIES }),
            });
            expect(t.$columns.priority.enum).toEqual(PRIORITIES);
            expect(t.$columns.priority.sqlType).toBe('INTEGER');
        });
    });

    // ── View builder ────────────────────────────────────────────────
    describe('view()', () => {
        const events = table('events', {
            id: id(),
            region: text(),
            value: integer(),
            ts: text(),
        });

        it('creates a view builder with $-prefixed metadata', () => {
            const v = view(events);
            expect(v.$tag).toBe('view');
            expect(v.$tableName).toBe('events');
            expect(v.$idKey).toBe('id');
            expect(v.$pipeline).toEqual([]);
            expect(v.$sourceTables).toEqual(['events']);
            expect(v.$monotonicity).toBe('unknown');
        });

        it('accepts ColumnRef in filter()', () => {
            const v = view(events).filter(events.region, 'eq', 'us-west');
            expect(v.$pipeline).toEqual([{ op: 'filter', field: 'region', eq: 'us-west' }]);
        });

        it('accepts string in filter()', () => {
            const v = view(events).filter('region', 'eq', 'us-east');
            expect(v.$pipeline[0]).toMatchObject({ op: 'filter', field: 'region' });
        });

        it('produces identical pipeline from string and ref forms', () => {
            const byString = view(events).filter('region', 'eq', 'x').topN('value', 5);
            const byRef = view(events).filter(events.region, 'eq', 'x').topN(events.value, 5);
            expect(byString.$pipeline).toEqual(byRef.$pipeline);
        });

        it('classifies filter-only pipelines as monotonic', () => {
            const v = view(events).filter(events.region, 'eq', 'x');
            expect(v.$monotonicity).toBe('monotonic');
        });

        it('classifies topN as non_monotonic', () => {
            const v = view(events).topN(events.value, 5);
            expect(v.$monotonicity).toBe('non_monotonic');
        });

        it('classifies aggregate as monotonic', () => {
            const v = view(events).aggregate([events.region], { total: sum(events.value) });
            expect(v.$monotonicity).toBe('monotonic');
        });

        it('classifies distinct as non_monotonic', () => {
            const v = view(events).distinct();
            expect(v.$monotonicity).toBe('non_monotonic');
        });

        it('aggregate with single group-by sets idKey to the group-by column', () => {
            const v = view(events).aggregate([events.region], {
                total: sum(events.value),
                count: count(),
            });
            expect(v.$idKey).toBe('region');
        });

        it('join tracks both source tables', () => {
            const other = table('other', {
                id: id(),
                region: text(),
                label: text(),
            });
            const v = view(events).join(other, events.region, other.region);
            expect(v.$sourceTables).toEqual(['events', 'other']);
            expect(v.$monotonicity).toBe('non_monotonic');
        });

        it('is identified by isView()', () => {
            const v = view(events);
            expect(isView(v)).toBe(true);
            expect(isView({})).toBe(false);
        });
    });

    // ── Aggregate helpers ───────────────────────────────────────────
    describe('sum/avg/min/max/count', () => {
        const events = table('events', {
            id: id(),
            value: integer(),
            label: text(),
        });

        it('sum(ref) produces the right shape', () => {
            expect(sum(events.value)).toEqual({ fn: 'sum', field: 'value' });
        });

        it('avg/min/max produce the right fn tag', () => {
            expect(avg(events.value).fn).toBe('avg');
            expect(min(events.value).fn).toBe('min');
            expect(max(events.value).fn).toBe('max');
        });

        it('count() has field "*"', () => {
            expect(count()).toEqual({ fn: 'count', field: '*' });
        });
    });

    // ── Merge config extraction ─────────────────────────────────────
    describe('extractMergeConfig()', () => {
        it('returns lww defaults for all non-PK columns', () => {
            const t = table('users', {
                id: id(),
                name: text(),
                age: integer(),
            });
            expect(extractMergeConfig(t)).toEqual({
                table: 'users',
                fields: { name: 'lww', age: 'lww' },
            });
        });

        it('skips columns with merge: false', () => {
            const t = table('users', {
                id: id(),
                name: text({ merge: false }),
                age: integer(),
            });
            expect(extractMergeConfig(t)).toEqual({
                table: 'users',
                fields: { age: 'lww' },
            });
        });

        it('returns null when every column opts out', () => {
            const t = table('users', {
                id: id(),
                name: text({ merge: false }),
            });
            expect(extractMergeConfig(t)).toBeNull();
        });
    });
});

// ── Type-level refactoring guarantees ────────────────────────────────────
//
// These don't run runtime assertions of their own — they exist so that
// tsc catches regressions in the type-level behavior promised by the
// ergonomics refresh. If tsc fails on any of these, a regression shipped.

describe('type-level guarantees', () => {
    it('sum(ref) rejects non-numeric column refs at compile time', () => {
        const t = table('t', { id: id(), label: text() });
        // @ts-expect-error — sum() requires a numeric column ref
        const _bad = sum(t.label);
        void _bad;
        expect(true).toBe(true);
    });

    it('filter requires matching value type', () => {
        const t = table('t', { id: id(), amount: real() });
        // @ts-expect-error — amount is number, not string
        view(t).filter(t.amount, 'eq', 'a string');
        expect(true).toBe(true);
    });

    it('topN sort-by must be a numeric column', () => {
        const t = table('t', { id: id(), label: text(), value: integer() });
        // @ts-expect-error — label is string, not numeric
        view(t).topN(t.label, 5);
        // ok
        view(t).topN(t.value, 5);
        expect(true).toBe(true);
    });

    it('$-prefixed column name is rejected at runtime', () => {
        // $-prefixed keys satisfy `Record<string, ColumnDef>`, so the check
        // lives at runtime instead of the type system.
        expect(() =>
            table('users', { id: id(), $name: text() }),
        ).toThrow(/\$/);
    });
});
