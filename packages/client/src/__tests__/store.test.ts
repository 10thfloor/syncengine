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
} from '@syncengine/core';
import type { SyncConfig } from '@syncengine/core/internal';
import type { StoreConfig } from '../store';

describe('Store configuration and schema payload', () => {
    describe('SyncConfig interface', () => {
        it('has required workspaceId', () => {
            const config: SyncConfig = {
                workspaceId: 'ws-123',
            };
            expect(config.workspaceId).toBe('ws-123');
        });

        it('supports optional natsUrl', () => {
            const config: SyncConfig = {
                workspaceId: 'ws-123',
                natsUrl: 'ws://localhost:9222',
            };
            expect(config.natsUrl).toBe('ws://localhost:9222');
        });

        it('supports optional restateUrl', () => {
            const config: SyncConfig = {
                workspaceId: 'ws-123',
                restateUrl: 'http://localhost:8080',
            };
            expect(config.restateUrl).toBe('http://localhost:8080');
        });

        it('supports both optional URLs', () => {
            const config: SyncConfig = {
                workspaceId: 'ws-123',
                natsUrl: 'ws://custom-nats:9222',
                restateUrl: 'http://custom-restate:8080',
            };
            expect(config.natsUrl).toBe('ws://custom-nats:9222');
            expect(config.restateUrl).toBe('http://custom-restate:8080');
        });
    });

    describe('StoreConfig validation', () => {
        it('accepts valid config with tables and views', () => {
            const t = table('users', { id: id(), name: text() });
            const v = view('all_users', t);

            const config: StoreConfig = {
                tables: [t],
                views: [v],
            };

            expect(config.tables).toHaveLength(1);
            expect(config.views).toHaveLength(1);
            expect(config.sync).toBeUndefined();
        });

        it('accepts config with sync settings', () => {
            const t = table('users', { id: id() });
            const v = view('all_users', t);

            const config: StoreConfig = {
                tables: [t],
                views: [v],
                sync: {
                    workspaceId: 'ws-123',
                },
            };

            expect(config.sync?.workspaceId).toBe('ws-123');
        });

        it('accepts multiple tables', () => {
            const users = table('users', { id: id() });
            const posts = table('posts', { id: id() });

            const config: StoreConfig = {
                tables: [users, posts],
                views: [],
            };

            expect(config.tables).toHaveLength(2);
        });

        it('accepts multiple views on same table', () => {
            const users = table('users', { id: id(), age: integer() });

            const config: StoreConfig = {
                tables: [users],
                views: [
                    view('all_users', users),
                    view('adults', users).filter('age', 'eq', 18),
                ],
            };

            expect(config.views).toHaveLength(2);
        });

        it('accepts empty views', () => {
            const t = table('users', { id: id() });

            const config: StoreConfig = {
                tables: [t],
                views: [],
            };

            expect(config.views).toHaveLength(0);
        });
    });

    describe('schema payload generation from StoreConfig', () => {
        it('generates correct table metadata', () => {
            const t = table('users', {
                id: id(),
                name: text(),
                age: integer(),
            });

            const config: StoreConfig = {
                tables: [t],
                views: [],
            };

            // We can't directly test tableToSQL since it's private,
            // but we can verify the table is properly structured
            expect(config.tables[0].name).toBe('users');
            expect(Object.keys(config.tables[0].columns)).toEqual([
                'id',
                'name',
                'age',
            ]);
        });

        it('preserves column information through config', () => {
            const t = table('products', {
                id: id(),
                price: real(),
                in_stock: boolean(),
            });

            const config: StoreConfig = {
                tables: [t],
                views: [],
            };

            const tbl = config.tables[0];
            expect(tbl.columns.id.primaryKey).toBe(true);
            expect(tbl.columns.price.sqlType).toBe('REAL');
            expect(tbl.columns.in_stock.sqlType).toBe('INTEGER');
        });

        it('includes merge configs in payload', () => {
            const t = table('events', {
                id: id(),
                count: integer({ merge: 'add' }),
                lastSeen: integer({ merge: 'lww' }),
            });

            const config: StoreConfig = {
                tables: [t],
                views: [],
            };

            const mergeConfig = extractMergeConfig(config.tables[0]);
            expect(mergeConfig).not.toBeNull();
            expect(mergeConfig?.table).toBe('events');
            expect(mergeConfig?.fields).toEqual({
                count: 'add',
                lastSeen: 'lww',
            });
        });

        it('filters out tables without merge config', () => {
            const withMerge = table('synced', {
                id: id(),
                value: integer({ merge: 'max' }),
            });
            const withoutMerge = table('local', {
                id: id(),
                data: text(),
            });

            const config: StoreConfig = {
                tables: [withMerge, withoutMerge],
                views: [],
            };

            const mergeConfigs = config.tables
                .map(extractMergeConfig)
                .filter((c): c is NonNullable<typeof c> => c !== null);

            expect(mergeConfigs).toHaveLength(1);
            expect(mergeConfigs[0].table).toBe('synced');
        });

        it('preserves view pipelines through config', () => {
            const t = table('sales', {
                id: id(),
                amount: integer(),
                category: text(),
            });

            const viewDef = view('high_value', t)
                .filter('amount', 'eq', 1000)
                .aggregate(['category'], { total: sum('amount') });

            const config: StoreConfig = {
                tables: [t],
                views: [viewDef],
            };

            const v = config.views[0];
            expect(v.name).toBe('high_value');
            expect(v.pipeline).toHaveLength(2);
            expect(v.pipeline[0].op).toBe('filter');
            expect(v.pipeline[1].op).toBe('aggregate');
            expect(v.monotonicity).toBe('monotonic');
        });

        it('tracks source tables in view definitions', () => {
            const users = table('users', { id: id() });
            const posts = table('posts', { id: id(), userId: integer() });

            const joined = view('user_posts', users).join(
                posts,
                'id',
                'userId',
            );

            const config: StoreConfig = {
                tables: [users, posts],
                views: [joined],
            };

            const v = config.views[0];
            expect(v.sourceTables).toContain('users');
            expect(v.sourceTables).toContain('posts');
        });

        it('handles complex schema with multiple tables and views', () => {
            const users = table('users', {
                id: id(),
                name: text({ merge: 'lww' }),
                score: integer({ merge: 'max' }),
            });

            const posts = table('posts', {
                id: id(),
                userId: integer(),
                title: text(),
                likes: integer({ merge: 'add' }),
            });

            const allUsers = view('all_users', users);
            const userTopPosts = view('top_posts_per_user', posts)
                .topN('likes', 5)
                .aggregate(['userId'], { total_likes: sum('likes') });
            const userJoinPost = view('users_with_posts', users).join(
                posts,
                'id',
                'userId',
            );

            const config: StoreConfig = {
                tables: [users, posts],
                views: [allUsers, userTopPosts, userJoinPost],
                sync: {
                    workspaceId: 'ws-demo',
                },
            };

            expect(config.tables).toHaveLength(2);
            expect(config.views).toHaveLength(3);

            const mergeConfigs = config.tables
                .map(extractMergeConfig)
                .filter((c): c is NonNullable<typeof c> => c !== null);
            expect(mergeConfigs).toHaveLength(2);

            expect(config.sync?.workspaceId).toBe('ws-demo');
        });
    });

    describe('view properties accessible through config', () => {
        it('view has correct name and table reference', () => {
            const products = table('products', { id: id() });
            const v = view('inventory', products);

            expect(v.name).toBe('inventory');
            expect(v.tableName).toBe('products');
        });

        it('view idKey matches table primary key', () => {
            const items = table('items', { itemId: id(), label: text() });
            const v = view('all_items', items);

            expect(v.idKey).toBe('itemId');
        });

        it('view with aggregate has updated idKey', () => {
            const sales = table('sales', {
                id: id(),
                region: text(),
                amount: integer(),
            });

            const byRegion = view('sales_by_region', sales).aggregate(
                ['region'],
                { total: sum('amount') },
            );

            expect(byRegion.idKey).toBe('region');
        });

        it('monotonicity is accessible through view', () => {
            const events = table('events', {
                id: id(),
                value: integer(),
            });

            const filtered = view('filtered', events).filter(
                'value',
                'eq',
                10,
            );
            const topN = view('top', events).topN('value', 5);

            expect(filtered.monotonicity).toBe('monotonic');
            expect(topN.monotonicity).toBe('non_monotonic');
        });
    });

    describe('schema composition', () => {
        it('supports building schema incrementally', () => {
            const users = table('users', {
                id: id(),
                name: text(),
            });
            const posts = table('posts', {
                id: id(),
                userId: integer(),
                content: text(),
            });

            const views = [
                view('all_users', users),
                view('user_posts_count', posts).aggregate(
                    ['userId'],
                    { count: count() },
                ),
            ];

            const config: StoreConfig = {
                tables: [users, posts],
                views,
            };

            expect(config.tables).toHaveLength(2);
            expect(config.views).toHaveLength(2);
        });

        it('table names must be unique in config', () => {
            // This test documents the expectation that duplicate table names
            // would be problematic (though not type-checked)
            const t1 = table('items', { id: id() });
            const t2 = table('items', { id: id() });

            const config: StoreConfig = {
                tables: [t1, t2],
                views: [],
            };

            // Both are in config but represent the same table name
            expect(config.tables[0].name).toBe(config.tables[1].name);
        });

        it('view names should be unique in config', () => {
            const t = table('users', { id: id() });
            const v1 = view('all', t);
            const v2 = view('all', t);

            const config: StoreConfig = {
                tables: [t],
                views: [v1, v2],
            };

            // Both have same name; config allows it but the worker would need to handle
            expect(config.views[0].name).toBe(config.views[1].name);
        });
    });
});
