import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../server.ts';
import { ProvisionCache } from '@syncengine/http-core';
import type { SyncengineConfig } from '@syncengine/core';

const FIXTURE = '/tmp/se-server-fixture';

beforeAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
    writeFileSync(
        join(FIXTURE, 'index.html'),
        `<!doctype html><html><head><title>App</title></head><body></body></html>`,
    );
    writeFileSync(join(FIXTURE, 'app-abcdef12.js'), 'console.log("hi");');
});

afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
});

const config: SyncengineConfig = {
    workspaces: {
        resolve: ({ request }) =>
            new URL(request.url).searchParams.get('workspace') ?? 'default',
    },
};

async function build() {
    return createServer({
        distDir: FIXTURE,
        config,
        natsUrl: 'ws://localhost:9222',
        restateUrl: 'http://localhost:8080',
        assetsPrefix: '/assets/',
        resolveTimeoutMs: 1000,
        devMode: true,
        // No-op provisioner — tests don't run a real Restate.
        provisionCache: new ProvisionCache(async () => {}),
    });
}

describe('createServer', () => {
    it('routes /_health to the liveness handler (200)', async () => {
        const server = await build();
        const res = await server.fetch(new Request('http://localhost/_health'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('json');
    });

    it('routes /_ready and flips 503 → 200 when markReady() is called', async () => {
        const server = await build();
        expect((await server.fetch(new Request('http://localhost/_ready'))).status).toBe(503);
        server.markReady();
        expect((await server.fetch(new Request('http://localhost/_ready'))).status).toBe(200);
    });

    it('serves static files with ETag + Cache-Control', async () => {
        const server = await build();
        const res = await server.fetch(new Request('http://localhost/app-abcdef12.js'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('javascript');
        expect(res.headers.get('cache-control')).toContain('immutable');
        expect(res.headers.get('etag')).toBeTruthy();
    });

    it('falls through to HTML handler for non-static paths', async () => {
        const server = await build();
        const res = await server.fetch(new Request('http://localhost/dashboard'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        const body = await res.text();
        expect(body).toContain('syncengine-workspace-id');
    });

    it('injects workspace-specific meta tags per request', async () => {
        const server = await build();
        const alice = await (await server.fetch(new Request('http://localhost/?workspace=alice'))).text();
        const bob = await (await server.fetch(new Request('http://localhost/?workspace=bob'))).text();
        const aKey = alice.match(/syncengine-workspace-id" content="([^"]+)"/)?.[1];
        const bKey = bob.match(/syncengine-workspace-id" content="([^"]+)"/)?.[1];
        expect(aKey).toBeTruthy();
        expect(bKey).toBeTruthy();
        expect(aKey).not.toBe(bKey);
    });

    it('non-GET/HEAD to an HTML path returns 405', async () => {
        const server = await build();
        const res = await server.fetch(
            new Request('http://localhost/', { method: 'POST' }),
        );
        expect(res.status).toBe(405);
    });

    it('static path with POST falls through to HTML handler → 405', async () => {
        const server = await build();
        const res = await server.fetch(
            new Request('http://localhost/app-abcdef12.js', { method: 'POST' }),
        );
        expect(res.status).toBe(405);
    });
});
