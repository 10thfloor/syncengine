import { describe, it, expect } from 'vitest';
import { generateNatsPermissions, type RoleSpec, type Roles } from '../nats-acl';
import type { ChannelConfig } from '../channels';
import { table, id, text } from '../schema';

// ── Fixtures (Phase 2.5 channel refs) ───────────────────────────────────────

const tasks = table('tasks', { id: id(), title: text() });
const announcements = table('announcements', { id: id(), body: text() });
const secrets = table('secrets', { id: id(), value: text() });

describe('generateNatsPermissions', () => {
    const workspaceId = 'acme';

    it('returns allow-lists scoped to ws.{id}.ch.{name}.deltas', () => {
        const role: RoleSpec = { read: ['public'], write: ['public'] };
        const perms = generateNatsPermissions(workspaceId, role);

        expect(perms.publish.allow).toEqual([`ws.${workspaceId}.ch.public.deltas`]);
        expect(perms.subscribe.allow).toEqual([`ws.${workspaceId}.ch.public.deltas`]);
    });

    it('returns empty deny-lists (ACLs are allow-list by convention)', () => {
        const role: RoleSpec = { read: ['a', 'b'], write: ['a'] };
        const perms = generateNatsPermissions(workspaceId, role);

        expect(perms.publish.deny).toEqual([]);
        expect(perms.subscribe.deny).toEqual([]);
    });

    it('supports asymmetric read/write roles (reader can only subscribe)', () => {
        const reader: RoleSpec = { read: ['team', 'public'], write: [] };
        const perms = generateNatsPermissions(workspaceId, reader);

        expect(perms.subscribe.allow).toEqual([
            `ws.${workspaceId}.ch.team.deltas`,
            `ws.${workspaceId}.ch.public.deltas`,
        ]);
        expect(perms.publish.allow).toEqual([]);
    });

    it('supports write-only roles (ingester can only publish)', () => {
        const ingester: RoleSpec = { read: [], write: ['events'] };
        const perms = generateNatsPermissions(workspaceId, ingester);

        expect(perms.subscribe.allow).toEqual([]);
        expect(perms.publish.allow).toEqual([`ws.${workspaceId}.ch.events.deltas`]);
    });

    it('preserves channel-list order in the subject allow-lists', () => {
        const role: RoleSpec = {
            read: ['z', 'a', 'm'],
            write: ['m', 'a', 'z'],
        };
        const perms = generateNatsPermissions(workspaceId, role);

        expect(perms.subscribe.allow).toEqual([
            `ws.${workspaceId}.ch.z.deltas`,
            `ws.${workspaceId}.ch.a.deltas`,
            `ws.${workspaceId}.ch.m.deltas`,
        ]);
        expect(perms.publish.allow).toEqual([
            `ws.${workspaceId}.ch.m.deltas`,
            `ws.${workspaceId}.ch.a.deltas`,
            `ws.${workspaceId}.ch.z.deltas`,
        ]);
    });

    it('handles empty read/write lists without throwing', () => {
        const role: RoleSpec = { read: [], write: [] };
        const perms = generateNatsPermissions(workspaceId, role);

        expect(perms.publish.allow).toEqual([]);
        expect(perms.subscribe.allow).toEqual([]);
    });

    it('embeds the workspaceId literally (no escaping — caller responsibility)', () => {
        const role: RoleSpec = { read: ['public'], write: ['public'] };
        const perms = generateNatsPermissions('my-prod-workspace', role);

        expect(perms.subscribe.allow[0]).toBe('ws.my-prod-workspace.ch.public.deltas');
    });
});

// ── Roles<T> type-level guarantees ─────────────────────────────────────────
//
// These don't run runtime assertions — they exist so tsc catches regressions
// in the channel-name union that `Roles<T>` resolves to.

describe('Roles<T> type guarantees', () => {
    it('constrains role channel names to the channel config', () => {
        // Typed channels: 'public' | 'team'
        const channels = [
            { name: 'public', tables: [announcements] },
            { name: 'team', tables: [tasks] },
        ] as const satisfies readonly ChannelConfig[];

        const roles: Roles<typeof channels, 'reader' | 'editor'> = {
            reader: { read: ['public', 'team'], write: [] },
            editor: { read: ['public', 'team'], write: ['team'] },
        };

        expect(roles.reader.read).toContain('public');
        expect(roles.editor.write).toEqual(['team']);

        const _bad: Roles<typeof channels, 'broken'> = {
            broken: {
                // @ts-expect-error — 'admin' is not a declared channel name
                read: ['admin'],
                write: [],
            },
        };
        void _bad;
    });

    it('per-role channel arrays can be any subset of declared channels', () => {
        const channels = [
            { name: 'public', tables: [announcements] },
            { name: 'team', tables: [tasks] },
            { name: 'vault', tables: [secrets] },
        ] as const satisfies readonly ChannelConfig[];

        const roles: Roles<typeof channels, 'guest' | 'admin'> = {
            guest: { read: ['public'], write: [] },
            admin: { read: ['public', 'team', 'vault'], write: ['public', 'team', 'vault'] },
        };

        expect(roles.guest.read).toHaveLength(1);
        expect(roles.admin.write).toHaveLength(3);
    });
});
