import { describe, it, expect, vi } from 'vitest';
import { ProvisionCache } from '../provision-cache.ts';

describe('ProvisionCache', () => {
    it('calls the provisioner exactly once per wsKey under concurrent load', async () => {
        const provisioner = vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 10));
        });
        const cache = new ProvisionCache(provisioner);

        // 10 concurrent calls for the same wsKey
        await Promise.all(
            Array.from({ length: 10 }, () => cache.ensureProvisioned('abc123')),
        );

        expect(provisioner).toHaveBeenCalledTimes(1);
        expect(provisioner).toHaveBeenCalledWith('abc123');
    });

    it('short-circuits after a successful provision', async () => {
        const provisioner = vi.fn(async () => {});
        const cache = new ProvisionCache(provisioner);

        await cache.ensureProvisioned('abc123');
        await cache.ensureProvisioned('abc123');
        await cache.ensureProvisioned('abc123');

        expect(provisioner).toHaveBeenCalledTimes(1);
    });

    it('caches independently per wsKey', async () => {
        const provisioner = vi.fn(async () => {});
        const cache = new ProvisionCache(provisioner);

        await cache.ensureProvisioned('abc');
        await cache.ensureProvisioned('def');
        await cache.ensureProvisioned('abc');
        await cache.ensureProvisioned('def');

        expect(provisioner).toHaveBeenCalledTimes(2);
        expect(provisioner).toHaveBeenCalledWith('abc');
        expect(provisioner).toHaveBeenCalledWith('def');
    });

    it('clears the cache entry on failure so retries are possible', async () => {
        let attempt = 0;
        const provisioner = vi.fn(async () => {
            attempt++;
            if (attempt === 1) throw new Error('restate down');
        });
        const cache = new ProvisionCache(provisioner);

        await expect(cache.ensureProvisioned('abc')).rejects.toThrow('restate down');

        // Second attempt must call provisioner again, not return the cached error
        await cache.ensureProvisioned('abc');
        expect(provisioner).toHaveBeenCalledTimes(2);
    });

    it('rejects all in-flight callers on a shared failure', async () => {
        const provisioner = vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 10));
            throw new Error('boom');
        });
        const cache = new ProvisionCache(provisioner);

        const results = await Promise.allSettled([
            cache.ensureProvisioned('abc'),
            cache.ensureProvisioned('abc'),
            cache.ensureProvisioned('abc'),
        ]);

        expect(results.every((r) => r.status === 'rejected')).toBe(true);
        expect(provisioner).toHaveBeenCalledTimes(1);
    });

    it('has() returns false before and true after a successful provision', async () => {
        const cache = new ProvisionCache(async () => {});

        expect(cache.has('abc')).toBe(false);
        await cache.ensureProvisioned('abc');
        expect(cache.has('abc')).toBe(true);
        expect(cache.has('def')).toBe(false);
    });

    it('has() returns false after a failed provision', async () => {
        const cache = new ProvisionCache(async () => {
            throw new Error('fail');
        });

        await expect(cache.ensureProvisioned('abc')).rejects.toThrow();
        expect(cache.has('abc')).toBe(false);
    });

    it('has() returns false while a provision is in flight', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const cache = new ProvisionCache(async () => { await gate; });

        const inflight = cache.ensureProvisioned('abc');
        expect(cache.has('abc')).toBe(false);
        release();
        await inflight;
        expect(cache.has('abc')).toBe(true);
    });
});
