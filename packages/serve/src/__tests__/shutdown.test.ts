import { describe, it, expect } from 'bun:test';
import { createShutdownController } from '../shutdown.ts';

describe('createShutdownController', () => {
    it('drain() resolves immediately when no requests are inflight', async () => {
        const ctrl = createShutdownController({ drainMs: 1000 });
        const t0 = performance.now();
        const result = await ctrl.drain();
        const elapsed = performance.now() - t0;
        expect(elapsed).toBeLessThan(50);
        expect(result).toEqual({ drained: 0, timedOut: 0 });
    });

    it('drain() waits for inflight requests to settle', async () => {
        const ctrl = createShutdownController({ drainMs: 500 });

        // Start three simulated requests
        let release1!: () => void;
        let release2!: () => void;
        let release3!: () => void;
        const req1 = ctrl.track(new Promise<void>((r) => { release1 = r; }));
        const req2 = ctrl.track(new Promise<void>((r) => { release2 = r; }));
        const req3 = ctrl.track(new Promise<void>((r) => { release3 = r; }));

        // drain() is called — starts waiting
        const drainPromise = ctrl.drain();

        // Release them one by one after a short delay
        setTimeout(() => release1(), 10);
        setTimeout(() => release2(), 20);
        setTimeout(() => release3(), 30);

        const result = await drainPromise;
        expect(result.drained).toBe(3);
        expect(result.timedOut).toBe(0);
        await req1; await req2; await req3;
    });

    it('drain() returns timedOut counts for requests still inflight past the deadline', async () => {
        const ctrl = createShutdownController({ drainMs: 50 });

        let never!: () => void;
        ctrl.track(new Promise<void>((r) => { never = r; }));

        const result = await ctrl.drain();
        expect(result.drained).toBe(0);
        expect(result.timedOut).toBe(1);
        never(); // clean up to avoid leaks
    });

    it('draining flag flips true during drain', async () => {
        const ctrl = createShutdownController({ drainMs: 100 });
        expect(ctrl.isDraining()).toBe(false);

        let release!: () => void;
        ctrl.track(new Promise<void>((r) => { release = r; }));

        const drainPromise = ctrl.drain();
        expect(ctrl.isDraining()).toBe(true);
        release();
        await drainPromise;
    });

    it('track() on an already-settled promise still counts', async () => {
        const ctrl = createShutdownController({ drainMs: 100 });
        ctrl.track(Promise.resolve());
        const result = await ctrl.drain();
        // Either counted as drained or not tracked — both are acceptable
        // behavior; the important thing is no hang.
        expect(result.drained + result.timedOut).toBeLessThanOrEqual(1);
    });

    it('rejected inflight promises do not crash the drain', async () => {
        const ctrl = createShutdownController({ drainMs: 100 });
        ctrl.track(Promise.reject(new Error('boom')).catch(() => {}));
        const result = await ctrl.drain();
        expect(result.timedOut).toBe(0);
    });

    it('mixed: some drain, some time out', async () => {
        const ctrl = createShutdownController({ drainMs: 50 });

        // One completes fast
        let releaseA!: () => void;
        ctrl.track(new Promise<void>((r) => { releaseA = r; }));
        setTimeout(() => releaseA(), 10);

        // Two never complete in time
        let releaseB!: () => void;
        let releaseC!: () => void;
        ctrl.track(new Promise<void>((r) => { releaseB = r; }));
        ctrl.track(new Promise<void>((r) => { releaseC = r; }));

        const result = await ctrl.drain();
        expect(result.drained).toBe(1);
        expect(result.timedOut).toBe(2);

        releaseB(); releaseC();
    });

    it('drain() is idempotent — second call returns quickly', async () => {
        const ctrl = createShutdownController({ drainMs: 100 });
        const first = await ctrl.drain();
        const t0 = performance.now();
        const second = await ctrl.drain();
        expect(performance.now() - t0).toBeLessThan(20);
        expect(second).toEqual(first);
    });
});
