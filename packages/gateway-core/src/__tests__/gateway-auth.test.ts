import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthHook } from '../auth-hook';
import { PASSTHROUGH_AUTH_HOOK } from '../auth-hook';

// GatewayCore's constructor tries to connect to NATS for the workspace
// registry subscription. We don't need that for auth tests — spy on
// console.warn to silence the expected warning and shortcut the test.
beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('AuthHook — pass-through defaults', () => {
    it('verifyInit returns null by default', async () => {
        const user = await PASSTHROUGH_AUTH_HOOK.verifyInit('any', 'ws1');
        expect(user).toBeNull();
    });

    it('authorizeChannel returns true by default', async () => {
        const allowed = await PASSTHROUGH_AUTH_HOOK.authorizeChannel(null, 'ws1', 'any-channel');
        expect(allowed).toBe(true);
    });
});

describe('AuthHook — contract', () => {
    it('verifyInit receives the token and workspace id', async () => {
        const verifyInit = vi.fn().mockResolvedValue({ id: 'alice', roles: ['admin'] });
        const hook: AuthHook = {
            verifyInit,
            authorizeChannel: async () => true,
        };
        await hook.verifyInit('alice-token', 'ws1');
        expect(verifyInit).toHaveBeenCalledWith('alice-token', 'ws1');
    });

    it('authorizeChannel receives the user, workspace id, and channel name', async () => {
        const authorizeChannel = vi.fn().mockResolvedValue(false);
        const hook: AuthHook = {
            verifyInit: async () => null,
            authorizeChannel,
        };
        const user = { id: 'alice', roles: ['viewer'] };
        await hook.authorizeChannel(user, 'ws1', 'admin-ch');
        expect(authorizeChannel).toHaveBeenCalledWith(user, 'ws1', 'admin-ch');
    });

    it('custom hook returning null for a given token is a rejection', async () => {
        const hook: AuthHook = {
            verifyInit: async (token) => (token === 'good' ? { id: 'alice' } : null),
            authorizeChannel: async () => true,
        };
        expect(await hook.verifyInit('good', 'ws1')).toEqual({ id: 'alice' });
        expect(await hook.verifyInit('bad', 'ws1')).toBeNull();
    });

    it('custom hook can return different results per channel name', async () => {
        const hook: AuthHook = {
            verifyInit: async () => null,
            authorizeChannel: async (user, _ws, ch) => {
                if (ch === 'public') return true;
                if (ch === 'admin') return user?.roles?.includes('admin') ?? false;
                return false;
            },
        };
        expect(await hook.authorizeChannel(null, 'ws1', 'public')).toBe(true);
        expect(await hook.authorizeChannel({ id: 'a' }, 'ws1', 'admin')).toBe(false);
        expect(await hook.authorizeChannel({ id: 'a', roles: ['admin'] }, 'ws1', 'admin')).toBe(true);
    });
});
