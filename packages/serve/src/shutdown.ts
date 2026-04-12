export interface ShutdownOptions {
    /** Max wait for in-flight requests during drain. Default 15s per
     *  design §3g. */
    readonly drainMs: number;
}

export interface DrainResult {
    /** Requests that finished inside the deadline. */
    readonly drained: number;
    /** Requests still inflight when the deadline expired. */
    readonly timedOut: number;
}

export interface ShutdownController {
    /** Wrap an inflight-request promise so drain() can wait for it. */
    track<T>(p: Promise<T>): Promise<T>;
    /** Stop accepting work and wait for tracked promises to settle
     *  (up to drainMs). Returns counts so the caller can log.
     *  Idempotent — second call returns the same result immediately. */
    drain(): Promise<DrainResult>;
    /** True between the first drain() call and its resolution. */
    isDraining(): boolean;
}

/**
 * Tiny lifecycle helper for SIGTERM drain. Wraps each response promise
 * so the main loop knows when the last request has finished. On drain:
 *   1. flips isDraining() → true
 *   2. waits (up to drainMs) for every tracked promise to settle
 *   3. returns { drained, timedOut } — the main loop logs and exits.
 */
export function createShutdownController(opts: ShutdownOptions): ShutdownController {
    const inflight = new Set<Promise<unknown>>();
    let draining = false;
    let cachedResult: DrainResult | null = null;

    return {
        track<T>(p: Promise<T>): Promise<T> {
            // Swallow rejections for tracking purposes so a request
            // error doesn't bubble into drain(). The caller still
            // sees its own rejection on the returned promise.
            const tracked = p.then(
                (v) => v,
                (err) => { throw err; },
            );
            const wrapper = tracked.catch(() => {});
            inflight.add(wrapper);
            wrapper.finally(() => inflight.delete(wrapper));
            return tracked;
        },

        async drain(): Promise<DrainResult> {
            if (cachedResult) return cachedResult;
            draining = true;
            const startSize = inflight.size;

            await new Promise<void>((resolveWait) => {
                if (inflight.size === 0) return resolveWait();

                const timer = setTimeout(() => {
                    resolveWait();
                }, opts.drainMs);

                void Promise.allSettled([...inflight]).then(() => {
                    clearTimeout(timer);
                    resolveWait();
                });
            });

            const remaining = inflight.size;
            cachedResult = {
                drained: startSize - remaining,
                timedOut: remaining,
            };
            return cachedResult;
        },

        isDraining(): boolean {
            return draining;
        },
    };
}
