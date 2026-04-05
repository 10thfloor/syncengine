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
    extractMergeConfig,
    type ChannelConfig,
} from '@syncengine/core';
import { validateStoreConfig, type StoreConfig, type SeedMap } from '../store';

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// store.test is a unit test over the Phase 2.5 config surface:
//   - StoreConfig shape (tables, views, channels?, seed?)
//   - validateStoreConfig() fail-fast rules
//   - schema payload construction from $-prefixed metadata
//
// The full `store(...)` factory talks to a Worker and a virtual runtime-config
// module, so it's exercised in integration tests and the live example app
// instead of here.

describe('Phase 2.5 store config', () => {
    describe('StoreConfig shape', () => {
        it('accepts a minimal config with tables and views', () => {
            const users = table('users', { id: id(), name: text() });
            const allUsers = view(users);

            const config: StoreConfig<readonly [typeof users]> = {
                tables: [users] as const,
                views: [allUsers],
            };

            expect(config.tables).toHaveLength(1);
            expect(config.views).toHaveLength(1);
            expect(config.channels).toBeUndefined();
            expect(config.seed).toBeUndefined();
        });

        it('accepts multiple tables', () => {
            const users = table('users', { id: id() });
            const posts = table('posts', { id: id() });

            const config: StoreConfig<readonly [typeof users, typeof posts]> = {
                tables: [users, posts] as const,
                views: [],
            };

            expect(config.tables).toHaveLength(2);
        });

        it('accepts multiple views on the same table', () => {
            const users = table('users', { id: id(), age: integer() });

            const config: StoreConfig<readonly [typeof users]> = {
                tables: [users] as const,
                views: [
                    view(users),
                    view(users).filter(users.age, 'eq', 18),
                ],
            };

            expect(config.views).toHaveLength(2);
            expect(config.views[0].$monotonicity).toBe('unknown');   // empty pipeline
            expect(config.views[1].$monotonicity).toBe('monotonic'); // filter only
        });

        it('accepts empty views', () => {
            const t = table('users', { id: id() });

            const config: StoreConfig<readonly [typeof t]> = {
                tables: [t] as const,
                views: [],
            };

            expect(config.views).toHaveLength(0);
        });

        it('accepts channels and seed', () => {
            const budgets = table('budgets', { id: id(), limit: real() });
            const channels: readonly ChannelConfig[] = [
                { name: 'config', tables: [budgets] },
            ] as const;
            const seed: SeedMap<readonly [typeof budgets]> = {
                budgets: [{ limit: 1000 }, { limit: 2000 }],
            };

            const config: StoreConfig<readonly [typeof budgets], typeof channels> = {
                tables: [budgets] as const,
                views: [],
                channels,
                seed,
            };

            expect(config.channels).toHaveLength(1);
            expect(config.seed?.budgets).toHaveLength(2);
        });
    });

    describe('schema metadata accessible via $-prefixed fields', () => {
        it('table exposes $name, $tag, $columns, $idKey', () => {
            const users = table('users', {
                id: id(),
                name: text(),
                age: integer(),
            });

            expect(users.$name).toBe('users');
            expect(users.$tag).toBe('table');
            expect(Object.keys(users.$columns)).toEqual(['id', 'name', 'age']);
            expect(users.$idKey).toBe('id');
        });

        it('preserves column information through config', () => {
            const products = table('products', {
                id: id(),
                price: real(),
                in_stock: boolean(),
            });

            const config: StoreConfig<readonly [typeof products]> = {
                tables: [products] as const,
                views: [],
            };

            const t = config.tables[0];
            expect(t.$columns.id.primaryKey).toBe(true);
            expect(t.$columns.price.sqlType).toBe('REAL');
            expect(t.$columns.in_stock.sqlType).toBe('INTEGER');
        });

        it('includes merge configs in payload — with lww defaults', () => {
            const events = table('events', {
                id: id(),
                count: integer({ merge: 'add' }),
                lastSeen: integer({ merge: 'lww' }),
            });

            const mergeConfig = extractMergeConfig(events);
            expect(mergeConfig).not.toBeNull();
            expect(mergeConfig?.table).toBe('events');
            expect(mergeConfig?.fields).toEqual({
                count: 'add',
                lastSeen: 'lww',
            });
        });

        it('filters out tables whose every non-PK column opts out', () => {
            const synced = table('synced', {
                id: id(),
                value: integer({ merge: 'max' }),
            });
            const local = table('local', {
                id: id(),
                data: text({ merge: false }),
            });

            const config: StoreConfig<readonly [typeof synced, typeof local]> = {
                tables: [synced, local] as const,
                views: [],
            };

            const mergeConfigs = config.tables
                .map(extractMergeConfig)
                .filter((c): c is NonNullable<typeof c> => c !== null);

            expect(mergeConfigs).toHaveLength(1);
            expect(mergeConfigs[0].table).toBe('synced');
        });

        it('preserves view pipelines through config', () => {
            const sales = table('sales', {
                id: id(),
                amount: integer(),
                category: text(),
            });

            const highValue = view(sales)
                .filter(sales.amount, 'eq', 1000)
                .aggregate([sales.category], { total: sum(sales.amount) });

            const config: StoreConfig<readonly [typeof sales]> = {
                tables: [sales] as const,
                views: [highValue],
            };

            const v = config.views[0];
            expect(v.$pipeline).toHaveLength(2);
            expect(v.$pipeline[0].op).toBe('filter');
            expect(v.$pipeline[1].op).toBe('aggregate');
            expect(v.$monotonicity).toBe('monotonic');
        });

        it('tracks source tables in view definitions', () => {
            const users = table('users', { id: id() });
            const posts = table('posts', { id: id(), userId: integer() });

            const joined = view(users).join(posts, users.id, posts.userId);

            const config: StoreConfig<readonly [typeof users, typeof posts]> = {
                tables: [users, posts] as const,
                views: [joined],
            };

            const v = config.views[0];
            expect(v.$sourceTables).toContain('users');
            expect(v.$sourceTables).toContain('posts');
        });

        it('handles a complex schema with multiple tables and views', () => {
            const users = table('users', {
                id: id(),
                name: text(),
                score: integer({ merge: 'max' }),
            });
            const posts = table('posts', {
                id: id(),
                userId: integer(),
                title: text(),
                likes: integer({ merge: 'add' }),
            });

            const allUsers = view(users);
            const topPosts = view(posts).topN(posts.likes, 5);
            const usersWithPosts = view(users).join(posts, users.id, posts.userId);

            const config: StoreConfig<readonly [typeof users, typeof posts]> = {
                tables: [users, posts] as const,
                views: [allUsers, topPosts, usersWithPosts],
            };

            expect(config.tables).toHaveLength(2);
            expect(config.views).toHaveLength(3);

            const mergeConfigs = config.tables
                .map(extractMergeConfig)
                .filter((c): c is NonNullable<typeof c> => c !== null);
            // Both tables carry at least one non-PK column → both have merge configs.
            expect(mergeConfigs).toHaveLength(2);
        });
    });

    describe('view properties accessible through config', () => {
        it('view exposes $tableName matching the source table', () => {
            const products = table('products', { id: id() });
            const v = view(products);

            expect(v.$tag).toBe('view');
            expect(v.$tableName).toBe('products');
        });

        it('view $idKey matches the source table primary key', () => {
            const items = table('items', { itemId: id(), label: text() });
            const v = view(items);

            expect(v.$idKey).toBe('itemId');
        });

        it('aggregate with single group-by rewrites $idKey to the group column', () => {
            const sales = table('sales', {
                id: id(),
                region: text(),
                amount: integer(),
            });

            const byRegion = view(sales).aggregate([sales.region], {
                total: sum(sales.amount),
            });

            expect(byRegion.$idKey).toBe('region');
        });

        it('monotonicity classifications match the pipeline', () => {
            const events = table('events', {
                id: id(),
                value: integer(),
            });

            const filtered = view(events).filter(events.value, 'eq', 10);
            const topN = view(events).topN(events.value, 5);
            const aggregated = view(events).aggregate([events.value], {
                count: count(),
            });
            const distinct = view(events).distinct();

            expect(filtered.$monotonicity).toBe('monotonic');
            expect(topN.$monotonicity).toBe('non_monotonic');
            expect(aggregated.$monotonicity).toBe('monotonic');
            expect(distinct.$monotonicity).toBe('non_monotonic');
        });
    });

    // ── validateStoreConfig() ───────────────────────────────────────────────
    //
    // validateStoreConfig runs every fail-fast rule declared at the top of
    // store.ts. These tests lock each rule independently so a regression in
    // any branch is caught here instead of leaking into live runtime failures.

    describe('validateStoreConfig', () => {
        it('accepts a valid minimal config', () => {
            const users = table('users', { id: id() });
            expect(() =>
                validateStoreConfig({ tables: [users], views: [] }),
            ).not.toThrow();
        });

        it('rejects duplicate table names', () => {
            const a = table('items', { id: id() });
            const b = table('items', { id: id() });
            expect(() =>
                validateStoreConfig({ tables: [a, b], views: [] }),
            ).toThrow(/Duplicate table name/);
        });

        it('rejects a view that references an unknown table', () => {
            const known = table('known', { id: id() });
            const orphan = table('orphan', { id: id() });
            const v = view(orphan);

            expect(() =>
                validateStoreConfig({ tables: [known], views: [v] }),
            ).toThrow(/unknown table/);
        });

        it('rejects a channel that references an unknown table', () => {
            const tasks = table('tasks', { id: id() });
            const orphan = table('orphan', { id: id() });

            expect(() =>
                validateStoreConfig({
                    tables: [tasks],
                    views: [],
                    channels: [{ name: 'team', tables: [tasks, orphan] }],
                }),
            ).toThrow(/unknown table/);
        });

        it('rejects a table not covered by any channel (when channels set)', () => {
            const tasks = table('tasks', { id: id() });
            const notes = table('notes', { id: id() });

            expect(() =>
                validateStoreConfig({
                    tables: [tasks, notes],
                    views: [],
                    channels: [{ name: 'team', tables: [tasks] }],
                }),
            ).toThrow(/not mapped to any channel/);
        });

        it('rejects duplicate channel names', () => {
            const t = table('t', { id: id() });
            expect(() =>
                validateStoreConfig({
                    tables: [t],
                    views: [],
                    channels: [
                        { name: 'dup', tables: [t] },
                        { name: 'dup', tables: [t] },
                    ],
                }),
            ).toThrow(/Duplicate channel name/);
        });

        it('rejects seed keys that do not match any table', () => {
            const tasks = table('tasks', { id: id(), title: text() });
            expect(() =>
                validateStoreConfig({
                    tables: [tasks],
                    views: [],
                    // cast: SeedMap is generic; this intentionally bypasses
                    // the compile-time check to exercise the runtime guard.
                    seed: { bogus: [{ title: 'nope' }] } as unknown as SeedMap<readonly [typeof tasks]>,
                }),
            ).toThrow(/does not correspond to any table/);
        });
    });

    // ── SeedMap type-level guarantees ──────────────────────────────────────
    //
    // SeedMap is a mapped type over config.tables. These checks don't assert
    // runtime behavior — they exist so that tsc flags regressions in the
    // per-table record shape expected by `store({ seed: {...} })`.

    describe('SeedMap type guarantees', () => {
        it('SeedMap key matches table $name', () => {
            const budgets = table('budgets', { id: id(), limit: real() });
            const seed: SeedMap<readonly [typeof budgets]> = {
                budgets: [{ limit: 1000 }],
            };
            expect(seed.budgets).toHaveLength(1);
        });

        it('SeedMap allows omitting the primary key', () => {
            const t = table('t', { id: id(), name: text() });
            const seed: SeedMap<readonly [typeof t]> = {
                t: [{ name: 'a' }, { name: 'b' }],
            };
            expect(seed.t).toHaveLength(2);
        });

        it('SeedMap allows providing the primary key explicitly', () => {
            const t = table('t', { id: id(), name: text() });
            const seed: SeedMap<readonly [typeof t]> = {
                t: [{ id: 1, name: 'a' }],
            };
            expect(seed.t?.[0].id).toBe(1);
        });
    });
});
