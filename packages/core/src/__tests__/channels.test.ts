import { describe, it, expect } from 'vitest';
import {
    buildChannelRouting,
    channel,
    resolvePublishSubjects,
    type ChannelConfig,
    type ChannelRouting,
} from '../channels';
import { Access } from '../auth';
import { table, id, text } from '../schema';
import type { SyncConfig } from '../internal/sync-types';

// Test fixtures — Table refs, not strings
const tasks = table('tasks', { id: id(), title: text() });
const announcements = table('announcements', { id: id(), body: text() });
const prs = table('prs', { id: id(), title: text() });
const shared = table('shared', { id: id(), label: text() });
const t1 = table('t1', { id: id() });
const t2 = table('t2', { id: id() });
const t3 = table('t3', { id: id() });

describe('Channel routing (Phase 2.5)', () => {
    const workspaceId = 'acme';

    describe('buildChannelRouting', () => {
        it('legacy mode: no channels → single default subject for all tables', () => {
            const sync: SyncConfig = { workspaceId };
            const routing = buildChannelRouting(sync, ['tasks', 'notes']);

            expect(routing.subjects).toEqual([`ws.${workspaceId}.deltas`]);
            expect(routing.tableToSubject).toEqual({
                tasks: `ws.${workspaceId}.deltas`,
                notes: `ws.${workspaceId}.deltas`,
            });
        });

        it('multi-channel mode: each channel maps to ws.{id}.ch.{name}.deltas', () => {
            const channels: ChannelConfig[] = [
                { name: 'public', tables: [announcements] },
                { name: 'team.eng', tables: [tasks, prs] },
            ];
            const sync = { workspaceId, channels };
            const routing = buildChannelRouting(sync, ['announcements', 'tasks', 'prs']);

            expect(routing.subjects).toEqual([
                `ws.${workspaceId}.ch.public.deltas`,
                `ws.${workspaceId}.ch.team.eng.deltas`,
            ]);
            expect(routing.tableToSubject).toEqual({
                announcements: `ws.${workspaceId}.ch.public.deltas`,
                tasks: `ws.${workspaceId}.ch.team.eng.deltas`,
                prs: `ws.${workspaceId}.ch.team.eng.deltas`,
            });
        });
    });

    describe('resolvePublishSubjects', () => {
        const routing: ChannelRouting = {
            subjects: [
                `ws.${workspaceId}.ch.public.deltas`,
                `ws.${workspaceId}.ch.team.eng.deltas`,
            ],
            tableToSubject: {
                announcements: `ws.${workspaceId}.ch.public.deltas`,
                tasks: `ws.${workspaceId}.ch.team.eng.deltas`,
            },
        };

        it('routes a table-scoped message to its channel subject', () => {
            expect(resolvePublishSubjects(routing, { type: 'INSERT', table: 'tasks' }))
                .toEqual([`ws.${workspaceId}.ch.team.eng.deltas`]);
        });

        it('fans out a workspace-wide message (no table) to every channel', () => {
            expect(resolvePublishSubjects(routing, { type: 'RESET' }))
                .toEqual(routing.subjects);
        });

        it('returns empty array for an unmapped table (silent drop)', () => {
            expect(resolvePublishSubjects(routing, { type: 'INSERT', table: 'unknown' }))
                .toEqual([]);
        });

        it('fan-out result is a copy (caller-safe mutation)', () => {
            const result = resolvePublishSubjects(routing, { type: 'RESET' });
            result.push('mutated');
            // Original routing.subjects should be unchanged
            expect(routing.subjects).toHaveLength(2);
        });
    });

    describe('buildChannelRouting edge cases', () => {
        it('empty channels array falls back to legacy mode', () => {
            const sync = { workspaceId, channels: [] };
            const routing = buildChannelRouting(sync, ['tasks']);
            expect(routing.subjects).toEqual([`ws.${workspaceId}.deltas`]);
            expect(routing.tableToSubject).toEqual({
                tasks: `ws.${workspaceId}.deltas`,
            });
        });

        it('double-assigned table: later channel wins', () => {
            const sync = {
                workspaceId,
                channels: [
                    { name: 'a', tables: [shared] },
                    { name: 'b', tables: [shared] },
                ],
            };
            const routing = buildChannelRouting(sync, ['shared']);
            expect(routing.tableToSubject.shared).toBe(`ws.${workspaceId}.ch.b.deltas`);
        });

        it('unassigned table: absent from tableToSubject (will not sync)', () => {
            const sync = {
                workspaceId,
                channels: [{ name: 'public', tables: [announcements] }],
            };
            const routing = buildChannelRouting(sync, ['announcements', 'orphan']);
            expect(routing.tableToSubject).toHaveProperty('announcements');
            expect(routing.tableToSubject).not.toHaveProperty('orphan');
        });

        it('channel subjects preserve declaration order', () => {
            const sync = {
                workspaceId,
                channels: [
                    { name: 'z', tables: [t1] },
                    { name: 'a', tables: [t2] },
                    { name: 'm', tables: [t3] },
                ],
            };
            const routing = buildChannelRouting(sync, ['t1', 't2', 't3']);
            expect(routing.subjects).toEqual([
                `ws.${workspaceId}.ch.z.deltas`,
                `ws.${workspaceId}.ch.a.deltas`,
                `ws.${workspaceId}.ch.m.deltas`,
            ]);
        });
    });
});

describe('channel() access policy (Plan 4)', () => {
    const t = table('t', { id: id(), body: text() });

    it('accepts an access policy in options', () => {
        const ch = channel('admin', [t], { access: Access.role('admin') });
        expect(ch.$access?.$kind).toBe('access');
    });

    it('defaults $access to null when opts omitted', () => {
        const ch = channel('public', [t]);
        expect(ch.$access).toBeNull();
    });

    it('defaults $access to null when opts provided without access', () => {
        const ch = channel('public', [t], {});
        expect(ch.$access).toBeNull();
    });

    it('accepts composed policies', () => {
        const ch = channel('restricted', [t], {
            access: Access.any(Access.role('admin'), Access.owner()),
        });
        expect(ch.$access?.$kind).toBe('access');
    });

    it('preserves the typed name generic', () => {
        const ch = channel('typed', [t], { access: Access.authenticated });
        // Type-level check: ch.name is the literal 'typed'
        const _nameType: 'typed' = ch.name;
        void _nameType;
        expect(ch.name).toBe('typed');
    });
});
