import { describe, it, expect } from 'vitest';
import {
    table,
    id,
    integer,
    real,
    text,
    boolean,
    view,
    sum,
    count,
    avg,
    min,
    max,
    extractMergeConfig,
} from '../schema';

describe('Schema DSL', () => {
    describe('table constructor', () => {
        it('creates correct structure', () => {
            const t = table('foo', {
                id: id(),
                name: text(),
                age: integer(),
            });

            expect(t._tag).toBe('table');
            expect(t.name).toBe('foo');
            expect(t.columns).toHaveProperty('id');
            expect(t.columns).toHaveProperty('name');
            expect(t.columns).toHaveProperty('age');
        });
    });

    describe('column constructors', () => {
        it('id() sets correct sqlType', () => {
            const col = id();
            expect(col.sqlType).toBe('INTEGER PRIMARY KEY');
            expect(col.primaryKey).toBe(true);
        });

        it('integer() sets correct sqlType', () => {
            const col = integer();
            expect(col.sqlType).toBe('INTEGER');
            expect(col.primaryKey).toBe(false);
        });

        it('real() sets correct sqlType', () => {
            const col = real();
            expect(col.sqlType).toBe('REAL');
        });

        it('text() sets correct sqlType', () => {
            const col = text();
            expect(col.sqlType).toBe('TEXT');
        });

        it('boolean() sets correct sqlType', () => {
            const col = boolean();
            expect(col.sqlType).toBe('INTEGER');
        });
    });

    describe('column merge annotation', () => {
        it('stores merge strategy when provided', () => {
            const col = real({ merge: 'lww' });
            expect(col.merge).toBe('lww');
        });

        it('has undefined merge by default', () => {
            const col = text();
            expect(col.merge).toBeUndefined();
        });

        it('supports all merge strategies', () => {
            const strategies = ['lww', 'set_union', 'max', 'min', 'add'] as const;
            for (const strategy of strategies) {
                const col = integer({ merge: strategy });
                expect(col.merge).toBe(strategy);
            }
        });
    });

    describe('view builder - basic operations', () => {
        it('creates pipeline with single filter', () => {
            const t = table('users', { id: id(), score: integer() });
            const v = view('high_score', t).filter('score', 'eq', 100);

            expect(v._tag).toBe('view');
            expect(v.name).toBe('high_score');
            expect(v.pipeline.length).toBe(1);
            expect(v.pipeline[0]).toEqual({
                op: 'filter',
                field: 'score',
                eq: 100,
            });
        });

        it('chains multiple operators', () => {
            const t = table('users', {
                id: id(),
                score: integer(),
                category: text(),
            });
            const v = view('top_scores', t)
                .filter('score', 'eq', 100)
                .topN('score', 10, 'desc')
                .aggregate(['category'], { total: count() });

            expect(v.pipeline.length).toBe(3);
            expect(v.pipeline[0].op).toBe('filter');
            expect(v.pipeline[1].op).toBe('topN');
            expect(v.pipeline[2].op).toBe('aggregate');
        });
    });

    describe('monotonicity classification', () => {
        it('filter-only pipeline is monotonic', () => {
            const t = table('users', { id: id(), age: integer() });
            const v = view('adults', t).filter('age', 'eq', 18);
            expect(v.monotonicity).toBe('monotonic');
        });

        it('empty pipeline is unknown', () => {
            const t = table('users', { id: id() });
            const v = view('all_users', t);
            expect(v.monotonicity).toBe('unknown');
        });

        it('topN is non_monotonic', () => {
            const t = table('users', {
                id: id(),
                score: integer(),
            });
            const v = view('top_users', t).topN('score', 10);
            expect(v.monotonicity).toBe('non_monotonic');
        });

        it('distinct is non_monotonic', () => {
            const t = table('users', { id: id(), name: text() });
            const v = view('unique_users', t).distinct();
            expect(v.monotonicity).toBe('non_monotonic');
        });

        it('aggregate alone is monotonic', () => {
            const t = table('users', {
                id: id(),
                category: text(),
                score: integer(),
            });
            const v = view('category_sums', t).aggregate(
                ['category'],
                { total_score: sum('score') },
            );
            expect(v.monotonicity).toBe('monotonic');
        });

        it('join is non_monotonic', () => {
            const users = table('users', { id: id(), name: text() });
            const posts = table('posts', { id: id(), userId: integer() });
            const v = view('users_with_posts', users).join(
                posts,
                'id',
                'userId',
            );
            expect(v.monotonicity).toBe('non_monotonic');
        });

        it('filter + aggregate is monotonic', () => {
            const t = table('events', {
                id: id(),
                type: text(),
                value: integer(),
            });
            const v = view('type_sums', t)
                .filter('type', 'eq', 'purchase')
                .aggregate(['type'], { total: sum('value') });
            expect(v.monotonicity).toBe('monotonic');
        });

        it('filter + topN is non_monotonic', () => {
            const t = table('events', {
                id: id(),
                type: text(),
                value: integer(),
            });
            const v = view('top_purchases', t)
                .filter('type', 'eq', 'purchase')
                .topN('value', 5);
            expect(v.monotonicity).toBe('non_monotonic');
        });
    });

    describe('view sourceTables tracking', () => {
        it('defaults to source table', () => {
            const t = table('users', { id: id() });
            const v = view('all_users', t);
            expect(v.sourceTables).toEqual(['users']);
        });

        it('tracks join sources', () => {
            const users = table('users', { id: id() });
            const posts = table('posts', { id: id(), userId: integer() });
            const v = view('users_posts', users).join(posts, 'id', 'userId');

            expect(v.sourceTables).toContain('users');
            expect(v.sourceTables).toContain('posts');
        });

        it('maintains source tables through filter', () => {
            const t = table('users', { id: id(), age: integer() });
            const v = view('adults', t).filter('age', 'eq', 18);
            expect(v.sourceTables).toEqual(['users']);
        });
    });

    describe('view idKey', () => {
        it('defaults to primary key column', () => {
            const t = table('users', { userId: id(), name: text() });
            const v = view('all_users', t);
            expect(v.idKey).toBe('userId');
        });

        it('falls back to "id" if no primary key', () => {
            const t = table('users', {
                userId: integer(),
                name: text(),
            });
            const v = view('all_users', t);
            expect(v.idKey).toBe('id');
        });

        it('updates idKey for aggregate grouping', () => {
            const t = table('events', {
                id: id(),
                category: text(),
                count: integer(),
            });
            const v = view('by_category', t).aggregate(['category'], {
                total: sum('count'),
            });
            expect(v.idKey).toBe('category');
        });
    });

    describe('aggregate helpers', () => {
        it('sum() creates correct definition', () => {
            const agg = sum('revenue');
            expect(agg).toEqual({ fn: 'sum', field: 'revenue' });
        });

        it('count() creates correct definition', () => {
            const agg = count();
            expect(agg).toEqual({ fn: 'count', field: '*' });
        });

        it('avg() creates correct definition', () => {
            const agg = avg('price');
            expect(agg).toEqual({ fn: 'avg', field: 'price' });
        });

        it('min() creates correct definition', () => {
            const agg = min('price');
            expect(agg).toEqual({ fn: 'min', field: 'price' });
        });

        it('max() creates correct definition', () => {
            const agg = max('price');
            expect(agg).toEqual({ fn: 'max', field: 'price' });
        });
    });

    describe('extractMergeConfig', () => {
        it('returns null for table with no merge fields', () => {
            const t = table('users', {
                id: id(),
                name: text(),
                age: integer(),
            });
            const config = extractMergeConfig(t);
            expect(config).toBeNull();
        });

        it('returns config for table with merge-annotated fields', () => {
            const t = table('users', {
                id: id(),
                name: text({ merge: 'lww' }),
                score: integer({ merge: 'max' }),
            });
            const config = extractMergeConfig(t);

            expect(config).not.toBeNull();
            expect(config?.table).toBe('users');
            expect(config?.fields).toEqual({
                name: 'lww',
                score: 'max',
            });
        });

        it('skips unannotated fields', () => {
            const t = table('data', {
                id: id(),
                plain: text(),
                merged: integer({ merge: 'add' }),
            });
            const config = extractMergeConfig(t);

            expect(config?.fields).not.toHaveProperty('plain');
            expect(config?.fields).toHaveProperty('merged');
        });

        it('handles single merge field', () => {
            const t = table('items', {
                id: id(),
                value: real({ merge: 'lww' }),
            });
            const config = extractMergeConfig(t);

            expect(config).not.toBeNull();
            expect(Object.keys(config!.fields).length).toBe(1);
            expect(config?.fields.value).toBe('lww');
        });

        it('handles multiple merge fields with different strategies', () => {
            const t = table('records', {
                id: id(),
                tags: text({ merge: 'set_union' }),
                maxValue: integer({ merge: 'max' }),
                minValue: integer({ merge: 'min' }),
                total: integer({ merge: 'add' }),
            });
            const config = extractMergeConfig(t);

            expect(config?.fields).toEqual({
                tags: 'set_union',
                maxValue: 'max',
                minValue: 'min',
                total: 'add',
            });
        });
    });
});
