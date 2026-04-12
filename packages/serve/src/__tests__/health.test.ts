import { describe, it, expect } from 'bun:test';
import { healthHandler, createReadinessHandler } from '../health.ts';

describe('healthHandler (liveness)', () => {
    it('returns 200 with JSON body', async () => {
        const res = await healthHandler(new Request('http://localhost/_health'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('json');
        const body = await res.json() as { ok: boolean; uptime_ms: number };
        expect(body.ok).toBe(true);
        expect(typeof body.uptime_ms).toBe('number');
        expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
    });

    it('responds to HEAD with 200 and no body', async () => {
        const res = await healthHandler(new Request('http://localhost/_health', { method: 'HEAD' }));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('');
    });

    it('has no side effects — returns the same shape regardless of request state', async () => {
        const a = await healthHandler(new Request('http://localhost/_health'));
        const b = await healthHandler(new Request('http://localhost/_health'));
        expect(a.status).toBe(b.status);
        const ja = await a.json() as { ok: boolean };
        const jb = await b.json() as { ok: boolean };
        expect(ja.ok).toBe(jb.ok);
    });
});

describe('createReadinessHandler', () => {
    it('returns 503 before markReady() is called', async () => {
        const { handler } = createReadinessHandler();
        const res = await handler(new Request('http://localhost/_ready'));
        expect(res.status).toBe(503);
    });

    it('returns 200 after markReady() is called', async () => {
        const { handler, markReady } = createReadinessHandler();
        markReady();
        const res = await handler(new Request('http://localhost/_ready'));
        expect(res.status).toBe(200);
    });

    it('body reflects the ready state', async () => {
        const { handler, markReady } = createReadinessHandler();
        const notReady = await handler(new Request('http://localhost/_ready'));
        const body1 = await notReady.json() as { ok: boolean };
        expect(body1.ok).toBe(false);

        markReady();
        const ready = await handler(new Request('http://localhost/_ready'));
        const body2 = await ready.json() as { ok: boolean };
        expect(body2.ok).toBe(true);
    });

    it('markReady() is idempotent', async () => {
        const { handler, markReady } = createReadinessHandler();
        markReady();
        markReady();
        markReady();
        const res = await handler(new Request('http://localhost/_ready'));
        expect(res.status).toBe(200);
    });

    it('multiple independent readiness handlers', async () => {
        const a = createReadinessHandler();
        const b = createReadinessHandler();
        a.markReady();
        // a is ready, b is not
        expect((await a.handler(new Request('http://localhost/_ready'))).status).toBe(200);
        expect((await b.handler(new Request('http://localhost/_ready'))).status).toBe(503);
    });
});
