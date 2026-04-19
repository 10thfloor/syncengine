import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unverified } from '../../auth/unverified-adapter';

describe('unverified() dev auth adapter', () => {
    let warnSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) as unknown as ReturnType<typeof vi.fn>;
    });
    afterEach(() => {
        (warnSpy as unknown as { mockRestore(): void }).mockRestore();
    });

    it('trusts the bearer token as the user id', async () => {
        const provider = unverified();
        const result = await provider.verify('alice');
        expect(result).toEqual({ ok: true, user: { id: 'alice' } });
    });

    it('rejects empty tokens', async () => {
        const provider = unverified();
        const result = await provider.verify('');
        expect(result.ok).toBe(false);
    });

    it('name is "unverified" so logs are obvious', () => {
        const provider = unverified();
        expect(provider.name).toBe('unverified');
    });

    it('warns at construction time — production guardrail', () => {
        unverified();
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls[0]![0]).toMatch(/unverified/i);
    });
});
