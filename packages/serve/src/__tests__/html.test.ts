import { describe, it, expect } from 'bun:test';
import { ProvisionCache } from '@syncengine/http-core';
import { createHtmlHandler } from '../html.ts';
import type { SyncengineConfig } from '@syncengine/core';

const BASE_HTML = `<!doctype html>
<html>
  <head><title>App</title></head>
  <body><div id="root"></div></body>
</html>`;

function config(overrides: {
    resolve?: SyncengineConfig['workspaces']['resolve'];
    verify?: (ctx: { request: Request }) => unknown;
} = {}): SyncengineConfig {
    return {
        workspaces: {
            resolve: overrides.resolve ?? (() => 'default'),
        },
        ...(overrides.verify ? { auth: { verify: overrides.verify as never } } : {}),
    };
}

function handler(opts: {
    cfg?: SyncengineConfig;
    cache?: ProvisionCache;
    dev?: boolean;
    meta?: { natsUrl?: string; restateUrl?: string; gatewayUrl?: string };
} = {}) {
    return createHtmlHandler({
        indexHtml: BASE_HTML,
        config: opts.cfg ?? config(),
        provisionCache: opts.cache ?? new ProvisionCache(async () => {}),
        natsUrl: opts.meta?.natsUrl ?? 'ws://localhost:9222',
        restateUrl: opts.meta?.restateUrl ?? 'http://localhost:8080',
        gatewayUrl: opts.meta?.gatewayUrl,
        devMode: opts.dev ?? false,
    });
}

describe('createHtmlHandler', () => {
    it('GET / returns 200 with injected meta tags', async () => {
        const h = handler();
        const res = await h(new Request('http://localhost/?workspace=alice'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        const body = await res.text();
        expect(body).toContain('<meta name="syncengine-workspace-id"');
        expect(body).toContain('<meta name="syncengine-nats-url" content="ws://localhost:9222">');
        expect(body).toContain('<meta name="syncengine-restate-url" content="http://localhost:8080">');
    });

    it('uses a different wsKey for different workspace ids', async () => {
        const h = handler({
            cfg: config({
                resolve: ({ request }) =>
                    new URL(request.url).searchParams.get('workspace') ?? 'default',
            }),
        });
        const alice = await (await h(new Request('http://localhost/?workspace=alice'))).text();
        const bob = await (await h(new Request('http://localhost/?workspace=bob'))).text();
        const aliceKey = alice.match(/syncengine-workspace-id" content="([^"]+)"/)?.[1];
        const bobKey = bob.match(/syncengine-workspace-id" content="([^"]+)"/)?.[1];
        expect(aliceKey).toBeTruthy();
        expect(bobKey).toBeTruthy();
        expect(aliceKey).not.toBe(bobKey);
    });

    it('gateway meta tag omitted when gatewayUrl not set', async () => {
        const res = await handler()(new Request('http://localhost/'));
        const body = await res.text();
        expect(body).not.toContain('syncengine-gateway-url');
    });

    it('gateway meta tag included when gatewayUrl set', async () => {
        const res = await handler({
            meta: { gatewayUrl: 'ws://localhost:9333/gateway' },
        })(new Request('http://localhost/'));
        const body = await res.text();
        expect(body).toContain('syncengine-gateway-url');
        expect(body).toContain('ws://localhost:9333/gateway');
    });

    it('HEAD returns 200 + headers and empty body', async () => {
        const res = await handler()(new Request('http://localhost/', { method: 'HEAD' }));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toBe('');
    });

    it('POST returns 405', async () => {
        const res = await handler()(new Request('http://localhost/', { method: 'POST' }));
        expect(res.status).toBe(405);
    });

    it('PUT/DELETE/PATCH also return 405', async () => {
        const h = handler();
        for (const method of ['PUT', 'DELETE', 'PATCH']) {
            const res = await h(new Request('http://localhost/', { method }));
            expect(res.status).toBe(405);
        }
    });

    it('auth.verify result flows into resolve()', async () => {
        let receivedUser: unknown = null;
        const h = handler({
            cfg: config({
                resolve: ({ user }) => {
                    receivedUser = user;
                    return 'ok';
                },
                verify: () => ({ id: 'alice', email: 'a@b' }),
            }),
        });
        await h(new Request('http://localhost/'));
        expect(receivedUser).toEqual({ id: 'alice', email: 'a@b' });
    });

    it('auth failure degrades to anonymous (still serves)', async () => {
        let receivedUser: unknown = null;
        const h = handler({
            cfg: config({
                resolve: ({ user }) => {
                    receivedUser = user;
                    return 'ok';
                },
                verify: () => { throw new Error('bad token'); },
            }),
        });
        const res = await h(new Request('http://localhost/'));
        expect(res.status).toBe(200);
        expect(receivedUser).toEqual({ id: 'anonymous' });
    });

    it('resolve() throw → 500 (prod: generic body)', async () => {
        const h = handler({
            dev: false,
            cfg: config({
                resolve: () => { throw new Error('internal whoopsie'); },
            }),
        });
        const res = await h(new Request('http://localhost/'));
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(body).not.toContain('internal whoopsie');
    });

    it('resolve() throw → 500 (dev: formatted platform error)', async () => {
        const h = handler({
            dev: true,
            cfg: config({
                resolve: () => { throw new Error('internal whoopsie'); },
            }),
        });
        const res = await h(new Request('http://localhost/'));
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(body).toContain('RESOLVE_FAILED');
        expect(body).toContain('internal whoopsie');
    });

    it('resolve() timeout → 504', async () => {
        const h = createHtmlHandler({
            indexHtml: BASE_HTML,
            config: config({
                resolve: () => new Promise((r) => setTimeout(() => r('late'), 100)),
            }),
            provisionCache: new ProvisionCache(async () => {}),
            natsUrl: 'ws://n',
            restateUrl: 'http://r',
            devMode: true,
            resolveTimeoutMs: 20,
        });
        const res = await h(new Request('http://localhost/'));
        expect(res.status).toBe(504);
    });

    it('provision failure → 502', async () => {
        const cache = new ProvisionCache(async () => { throw new Error('ECONNREFUSED'); });
        const h = handler({ cache });
        const res = await h(new Request('http://localhost/'));
        expect(res.status).toBe(502);
    });

    it('echoes X-Request-Id when supplied', async () => {
        const res = await handler()(
            new Request('http://localhost/', {
                headers: { 'x-request-id': 'req-abc-123' },
            }),
        );
        expect(res.headers.get('x-request-id')).toBe('req-abc-123');
    });

    it('generates X-Request-Id when not supplied', async () => {
        const res = await handler()(new Request('http://localhost/'));
        const id = res.headers.get('x-request-id');
        expect(id).toBeTruthy();
        expect(id!.length).toBeGreaterThan(8);
    });

    it('sets Cache-Control: no-cache on HTML responses', async () => {
        const res = await handler()(new Request('http://localhost/'));
        expect(res.headers.get('cache-control')).toContain('no-cache');
    });
});
