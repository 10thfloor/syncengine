import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createRpcHandler } from '../rpc.ts';

const RESTATE = 'http://restate.test:8080';

// Stub global fetch so we can observe what the proxy forwards without
// a real Restate. Bun's bun:test supports patching global.fetch.
let captured: { url: string; init: RequestInit } | null = null;
let fetchResponder: (url: string, init: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
    captured = null;
    fetchResponder = () => new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
    // @ts-expect-error — test stub
    globalThis.fetch = async (url: string | URL, init: RequestInit) => {
        captured = { url: String(url), init };
        return fetchResponder(String(url), init);
    };
});

afterEach(() => {
    // Bun's built-in fetch returns on each test import; no teardown needed
    // beyond nulling captured.
    captured = null;
});

describe('createRpcHandler', () => {
    it('returns null for non-/__syncengine/rpc paths (lets static/html handle)', async () => {
        const h = createRpcHandler({ restateUrl: RESTATE });
        const res = await h(new Request('http://x/assets/app.js'));
        expect(res).toBeNull();
    });

    it('returns 405 for GET to an rpc path', async () => {
        const h = createRpcHandler({ restateUrl: RESTATE });
        const res = await h(new Request('http://x/__syncengine/rpc/workflow/pomodoro/inv-1', {
            method: 'GET',
        }));
        expect(res!.status).toBe(405);
        expect(res!.headers.get('allow')).toContain('POST');
    });

    it('proxies workflow invocations to the correct Restate URL', async () => {
        const h = createRpcHandler({ restateUrl: RESTATE });
        const res = await h(
            new Request('http://x/__syncengine/rpc/workflow/pomodoro/inv-42', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-syncengine-workspace': 'abc123',
                },
                body: '{"durationMs":1500}',
            }),
        );
        expect(res!.status).toBe(200);
        expect(captured).not.toBeNull();
        // /workflow_pomodoro/<encoded "abc123/inv-42">/run
        expect(captured!.url).toContain('/workflow_pomodoro/');
        expect(captured!.url).toContain(encodeURIComponent('abc123/inv-42'));
        expect(captured!.url).toEndWith('/run');
    });

    it('proxies heartbeat invocations to /heartbeat_<name>/…/run', async () => {
        const h = createRpcHandler({ restateUrl: RESTATE });
        const res = await h(
            new Request('http://x/__syncengine/rpc/heartbeat/pulse/boot-1', {
                method: 'POST',
                headers: { 'x-syncengine-workspace': 'abc123' },
                body: '{}',
            }),
        );
        expect(res!.status).toBe(200);
        expect(captured!.url).toContain('/heartbeat_pulse/');
        expect(captured!.url).toEndWith('/run');
    });

    it('proxies entity handler invocations (three-part path)', async () => {
        const h = createRpcHandler({ restateUrl: RESTATE });
        const res = await h(
            new Request('http://x/__syncengine/rpc/counter/mainKey/increment', {
                method: 'POST',
                headers: { 'x-syncengine-workspace': 'abc123' },
                body: '{}',
            }),
        );
        expect(res!.status).toBe(200);
        expect(captured!.url).toContain('/entity_counter/');
        expect(captured!.url).toContain(encodeURIComponent('abc123/mainKey'));
        expect(captured!.url).toEndWith('/increment');
    });

    it('defaults to the hashed default workspace when no header is present', async () => {
        const h = createRpcHandler({ restateUrl: RESTATE });
        const res = await h(
            new Request('http://x/__syncengine/rpc/workflow/pomodoro/inv-1', {
                method: 'POST',
                body: '{}',
            }),
        );
        expect(res!.status).toBe(200);
        // hashWorkspaceId('default') is a 16-char hex digest; the url
        // contains "<wsKey>/inv-1" url-encoded. Rather than recomputing,
        // assert the forwarded header matches the URL.
        const fwd = captured!.init.headers as Record<string, string>;
        const wsKey = fwd['x-syncengine-workspace'];
        expect(wsKey).toMatch(/^[0-9a-f]{16}$/);
        expect(captured!.url).toContain(encodeURIComponent(`${wsKey}/inv-1`));
    });

    it('rejects an invalid workspace header with 400', async () => {
        const h = createRpcHandler({ restateUrl: RESTATE });
        const res = await h(
            new Request('http://x/__syncengine/rpc/workflow/pomodoro/inv-1', {
                method: 'POST',
                headers: { 'x-syncengine-workspace': 'has spaces' },
                body: '{}',
            }),
        );
        expect(res!.status).toBe(400);
    });

    it('returns 502 when Restate is unreachable', async () => {
        fetchResponder = () => {
            throw new Error('ECONNREFUSED');
        };
        const h = createRpcHandler({ restateUrl: RESTATE });
        const res = await h(
            new Request('http://x/__syncengine/rpc/workflow/pomodoro/inv-1', {
                method: 'POST',
                headers: { 'x-syncengine-workspace': 'abc123' },
                body: '{}',
            }),
        );
        expect(res!.status).toBe(502);
        expect(await res!.text()).toContain('ECONNREFUSED');
    });

    it('stamps x-request-id on both forwarded request and response', async () => {
        const h = createRpcHandler({ restateUrl: RESTATE });
        const res = await h(
            new Request('http://x/__syncengine/rpc/workflow/pomodoro/inv-1', {
                method: 'POST',
                headers: {
                    'x-syncengine-workspace': 'abc123',
                    'x-request-id': 'req-abc',
                },
                body: '{}',
            }),
        );
        expect(res!.headers.get('x-request-id')).toBe('req-abc');
        const fwd = captured!.init.headers as Record<string, string>;
        expect(fwd['x-request-id']).toBe('req-abc');
    });

    it('rejects malformed workflow paths (missing invocation id) with 400', async () => {
        const h = createRpcHandler({ restateUrl: RESTATE });
        const res = await h(
            new Request('http://x/__syncengine/rpc/workflow/pomodoro', {
                method: 'POST',
                headers: { 'x-syncengine-workspace': 'abc123' },
                body: '{}',
            }),
        );
        expect(res!.status).toBe(400);
    });
});
