/**
 * In-flight deduplicating cache for per-workspace provisioning calls.
 *
 * Semantics:
 *   - ensureProvisioned(wsKey) invokes the provisioner at most once per
 *     wsKey across the process lifetime, on success.
 *   - Concurrent callers for the same wsKey share a single in-flight
 *     promise — prevents the "cold binary, 100 tabs, 100 provision calls"
 *     thundering herd.
 *   - Failed provisions clear the cache entry so a retry can try again.
 *   - has(wsKey) is true only once an ensure has fully resolved.
 *
 * Owner: the serve binary creates one cache at startup; the Vite plugin
 * creates one per dev session. Lifetime == process lifetime; no TTL.
 */
export class ProvisionCache {
    #provision: (wsKey: string) => Promise<void>;
    #inflight = new Map<string, Promise<void>>();
    #done = new Set<string>();

    constructor(provision: (wsKey: string) => Promise<void>) {
        this.#provision = provision;
    }

    ensureProvisioned(wsKey: string): Promise<void> {
        if (this.#done.has(wsKey)) return Promise.resolve();
        const existing = this.#inflight.get(wsKey);
        if (existing) return existing;

        const p = this.#provision(wsKey)
            .then(() => {
                this.#done.add(wsKey);
            })
            .finally(() => {
                this.#inflight.delete(wsKey);
            });
        this.#inflight.set(wsKey, p);
        return p;
    }

    has(wsKey: string): boolean {
        return this.#done.has(wsKey);
    }
}
