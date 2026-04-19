import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Access, channel, table, id, text } from '@syncengine/core';
import { buildAuthHook } from '../../auth/build-auth-hook';
import { registerChannels, __resetChannelRegistry } from '../../auth/channel-registry';
import { unverified } from '../../auth/unverified-adapter';

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __resetChannelRegistry();
});
afterEach(() => {
    vi.restoreAllMocks();
    __resetChannelRegistry();
});

describe('buildAuthHook', () => {
    const t = table('audit', { id: id(), body: text() });
    const publicCh = channel('public', [t]);
    const adminCh = channel('admin', [t], { access: Access.role('admin') });

    it('verifyInit delegates to the configured provider', async () => {
        const hook = buildAuthHook({
            provider: unverified(),
            lookupRole: async () => 'member',
        });
        const user = await hook.verifyInit('alice', 'ws1');
        expect(user).toEqual({ id: 'alice', roles: ['member'] });
    });

    it('verifyInit returns null when no provider is configured', async () => {
        const hook = buildAuthHook({
            provider: undefined,
            lookupRole: async () => null,
        });
        const user = await hook.verifyInit('any-token', 'ws1');
        expect(user).toBeNull();
    });

    it('authorizeChannel allows channels without a registered policy', async () => {
        // No channels registered — every channel is public
        const hook = buildAuthHook({
            provider: unverified(),
            lookupRole: async () => null,
        });
        const allowed = await hook.authorizeChannel({ id: 'alice' }, 'ws1', 'anything');
        expect(allowed).toBe(true);
    });

    it('authorizeChannel allows channels declared without $access', async () => {
        registerChannels([publicCh]);
        const hook = buildAuthHook({
            provider: unverified(),
            lookupRole: async () => null,
        });
        const allowed = await hook.authorizeChannel({ id: 'alice' }, 'ws1', 'public');
        expect(allowed).toBe(true);
    });

    it('authorizeChannel evaluates registered policies', async () => {
        registerChannels([publicCh, adminCh]);
        const hook = buildAuthHook({
            provider: unverified(),
            lookupRole: async () => null,
        });

        const adminUser = { id: 'alice', roles: ['admin'] };
        const viewerUser = { id: 'bob', roles: ['viewer'] };

        expect(await hook.authorizeChannel(adminUser, 'ws1', 'admin')).toBe(true);
        expect(await hook.authorizeChannel(viewerUser, 'ws1', 'admin')).toBe(false);
        expect(await hook.authorizeChannel(null, 'ws1', 'admin')).toBe(false);
    });

    it('authorizeChannel: public channel is allowed for anonymous users', async () => {
        registerChannels([publicCh]);
        const hook = buildAuthHook({
            provider: unverified(),
            lookupRole: async () => null,
        });
        expect(await hook.authorizeChannel(null, 'ws1', 'public')).toBe(true);
    });
});

describe('channel-registry', () => {
    it('getChannelAccess returns null for unknown channels', async () => {
        const { getChannelAccess } = await import('../../auth/channel-registry');
        expect(getChannelAccess('nonexistent')).toBeNull();
    });

    it('registerChannels replaces the full list', async () => {
        const { getChannelAccess } = await import('../../auth/channel-registry');
        const t = table('t', { id: id() });
        registerChannels([channel('a', [t], { access: Access.role('admin') })]);
        expect(getChannelAccess('a')?.$kind).toBe('access');
        registerChannels([channel('b', [t])]);
        expect(getChannelAccess('a')).toBeNull();
        expect(getChannelAccess('b')).toBeNull();
    });
});
