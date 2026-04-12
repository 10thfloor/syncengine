/**
 * Tests for the devtools action endpoint — specifically the `reset`
 * action's URL construction and response contract. Regressions here
 * manifest as "reset workspace in devtools does nothing": the browser
 * still fires the POST, the middleware still 200s, but the Restate
 * call hits the wrong path or silently fails.
 *
 * We mock `fetch` to intercept the Restate ingress call and verify the
 * handler's URL + body. No network, no Restate process required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { devtoolsMiddleware } from '../devtools/devtools-plugin';
import type { DevRuntimeJson } from '../dev-runtime';

// ── Test harness ────────────────────────────────────────────────────────────

interface MockRes {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    done: Promise<void>;
    resolve: () => void;
}

function mockRes(): MockRes {
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const res: MockRes = {
        statusCode: 0,
        headers: {},
        body: '',
        done,
        resolve,
    };
    return res;
}

function buildReq(body: unknown): IncomingMessage {
    const stream = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
    const req = stream as unknown as IncomingMessage;
    (req as unknown as { url: string }).url = '/__syncengine/devtools/action';
    (req as unknown as { method: string }).method = 'POST';
    (req as unknown as { headers: Record<string, string> }).headers = {
        'content-type': 'application/json',
    };
    return req;
}

function writeRes(m: MockRes): ServerResponse {
    return {
        set statusCode(v: number) { m.statusCode = v; },
        get statusCode() { return m.statusCode; },
        setHeader(name: string, value: string) { m.headers[name.toLowerCase()] = value; },
        end(chunk?: string) {
            m.body = chunk ?? '';
            m.resolve();
        },
    } as unknown as ServerResponse;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('devtools action: reset', () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchSpy.mockReset();
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => ({ ok: true, message: 'reset workspace abc123' }),
            text: async () => '',
            status: 200,
        });
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    const runtime = (): DevRuntimeJson => ({ restateUrl: 'http://localhost:8080' } as DevRuntimeJson);

    it('POSTs to /workspace/<wsId>/reset on the Restate ingress', async () => {
        const middleware = devtoolsMiddleware(runtime);
        const req = buildReq({ action: 'reset', workspaceId: 'abc123' });
        const res = mockRes();
        const next = vi.fn();

        middleware(req, writeRes(res), next);
        await res.done;

        // A real reset invocation should be the only fetch that landed.
        const resetCalls = fetchSpy.mock.calls.filter(
            (c) => String(c[0] ?? '').includes('/workspace/') && String(c[0] ?? '').endsWith('/reset'),
        );
        expect(resetCalls).toHaveLength(1);

        const [url, opts] = resetCalls[0]!;
        expect(url).toBe('http://localhost:8080/workspace/abc123/reset');
        expect(opts).toMatchObject({ method: 'POST' });
        expect(JSON.parse(String((opts as { body?: unknown }).body ?? '{}'))).toMatchObject({
            tenantId: 'default',
        });
    });

    it('URL-encodes the workspace id segment', async () => {
        const middleware = devtoolsMiddleware(runtime);
        const req = buildReq({ action: 'reset', workspaceId: 'ws with space' });
        const res = mockRes();

        middleware(req, writeRes(res), vi.fn());
        await res.done;

        const resetCall = fetchSpy.mock.calls.find(
            (c) => String(c[0] ?? '').includes('/workspace/') && String(c[0] ?? '').endsWith('/reset'),
        );
        expect(resetCall).toBeDefined();
        expect(String(resetCall![0])).toBe('http://localhost:8080/workspace/ws%20with%20space/reset');
    });

    it('returns the Restate response verbatim when the call succeeds', async () => {
        const middleware = devtoolsMiddleware(runtime);
        const req = buildReq({ action: 'reset', workspaceId: 'abc' });
        const res = mockRes();

        middleware(req, writeRes(res), vi.fn());
        await res.done;

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true, message: 'reset workspace abc123' });
    });

    it('surfaces a non-200 Restate response as 400 with a parseable body', async () => {
        fetchSpy.mockReset();
        fetchSpy.mockImplementation(async (url: string) => {
            if (String(url).endsWith('/reset')) {
                return {
                    ok: false,
                    status: 500,
                    text: async () => 'upstream error',
                    json: async () => { throw new Error('not JSON'); },
                };
            }
            return { ok: true, json: async () => ({}), text: async () => '' };
        });

        const middleware = devtoolsMiddleware(runtime);
        const req = buildReq({ action: 'reset', workspaceId: 'abc' });
        const res = mockRes();

        middleware(req, writeRes(res), vi.fn());
        await res.done;

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.ok).toBe(false);
        expect(typeof body.message).toBe('string');
    });

    it('rejects unknown actions with a structured error', async () => {
        const middleware = devtoolsMiddleware(runtime);
        const req = buildReq({ action: 'nope', workspaceId: 'abc' });
        const res = mockRes();

        middleware(req, writeRes(res), vi.fn());
        await res.done;

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body)).toMatchObject({
            ok: false,
            message: expect.stringContaining('unknown action'),
        });
    });
});
