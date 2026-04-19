import { describe, it, expect } from 'vitest';
import type { AuthProvider, AuthVerifyResult } from '../auth-provider';

describe('AuthProvider interface', () => {
    it('accepts a conforming object with a verify function', () => {
        const provider: AuthProvider = {
            name: 'test',
            verify: async () => ({
                ok: true,
                user: { id: 'u1', email: 'alice@example.com', claims: {} },
            }),
        };
        expect(provider.name).toBe('test');
    });

    it('accepts an optional refresh function', () => {
        const provider: AuthProvider = {
            name: 'test',
            verify: async () => ({ ok: false, reason: 'expired' }),
            refresh: async () => 'new-token',
        };
        expect(provider.refresh).toBeDefined();
    });
});

describe('AuthVerifyResult', () => {
    it('discriminates on ok: true', () => {
        const ok: AuthVerifyResult = { ok: true, user: { id: 'u' } };
        expect(ok.ok).toBe(true);
        if (ok.ok) expect(ok.user.id).toBe('u');
    });

    it('discriminates on ok: false with a reason', () => {
        const err: AuthVerifyResult = { ok: false, reason: 'expired' };
        expect(err.ok).toBe(false);
        if (!err.ok) expect(err.reason).toBe('expired');
    });
});
