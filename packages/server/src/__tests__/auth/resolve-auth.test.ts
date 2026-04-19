import { describe, it, expect, vi } from 'vitest';
import { resolveAuth } from '../../auth/resolve-auth';
import { unverified } from '../../auth/unverified-adapter';

// Silence the unverified()-at-construction warning in tests.
vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('resolveAuth', () => {
    it('returns null user when provider is undefined', async () => {
        const user = await resolveAuth({
            provider: undefined,
            authHeader: 'Bearer alice',
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user).toBeNull();
    });

    it('returns null user when no Authorization header', async () => {
        const user = await resolveAuth({
            provider: unverified(),
            authHeader: undefined,
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user).toBeNull();
    });

    it('verifies token + enriches with workspace role', async () => {
        const lookupRole = vi.fn().mockResolvedValue('admin');
        const user = await resolveAuth({
            provider: unverified(),
            authHeader: 'Bearer alice',
            workspaceId: 'ws1',
            lookupRole,
        });
        expect(user).toEqual({ id: 'alice', roles: ['admin'] });
        expect(lookupRole).toHaveBeenCalledWith('alice', 'ws1');
    });

    it('verified user with no workspace membership has empty roles', async () => {
        const user = await resolveAuth({
            provider: unverified(),
            authHeader: 'Bearer stranger',
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user).toEqual({ id: 'stranger', roles: [] });
    });

    it('rejected token yields null user', async () => {
        const provider = {
            name: 'fail',
            verify: async () => ({ ok: false as const, reason: 'expired' }),
        };
        const user = await resolveAuth({
            provider,
            authHeader: 'Bearer anything',
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user).toBeNull();
    });

    it('parses the bearer prefix case-insensitively', async () => {
        const user = await resolveAuth({
            provider: unverified(),
            authHeader: 'bearer alice',
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user?.id).toBe('alice');
    });

    it('rejects headers missing the bearer prefix', async () => {
        const user = await resolveAuth({
            provider: unverified(),
            authHeader: 'alice',
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user).toBeNull();
    });

    it('returns null when the token after Bearer is empty', async () => {
        const user = await resolveAuth({
            provider: unverified(),
            authHeader: 'Bearer ',
            workspaceId: 'ws1',
            lookupRole: async () => null,
        });
        expect(user).toBeNull();
    });
});
