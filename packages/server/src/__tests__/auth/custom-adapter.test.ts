import { describe, it, expect } from 'vitest';
import { custom } from '../../auth/custom-adapter';

describe('custom() auth adapter', () => {
    it('delegates to the user-supplied verify function', async () => {
        const provider = custom({
            verify: async (token) => {
                if (token === 'alice-token') {
                    return { ok: true, user: { id: 'alice' } };
                }
                return { ok: false, reason: 'invalid' };
            },
        });
        expect(provider.name).toBe('custom');
        const ok = await provider.verify('alice-token');
        expect(ok).toEqual({ ok: true, user: { id: 'alice' } });
        const bad = await provider.verify('garbage');
        expect(bad).toEqual({ ok: false, reason: 'invalid' });
    });

    it('passes through optional refresh handler', async () => {
        const provider = custom({
            verify: async () => ({ ok: false, reason: 'expired' }),
            refresh: async (token) => (token === 'r1' ? 'new-token' : null),
        });
        expect(await provider.refresh!('r1')).toBe('new-token');
        expect(await provider.refresh!('unknown')).toBeNull();
    });

    it('refresh is undefined when not provided', () => {
        const provider = custom({
            verify: async () => ({ ok: true, user: { id: 'u' } }),
        });
        expect(provider.refresh).toBeUndefined();
    });
});
