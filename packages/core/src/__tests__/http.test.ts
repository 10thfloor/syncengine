import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { workspaceMemberRole } from '../http';

describe('workspaceMemberRole', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('returns the role when workspace.isMember says yes', async () => {
        globalThis.fetch = vi.fn(async () => new Response(
            JSON.stringify({ isMember: true, role: 'admin' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch;

        const role = await workspaceMemberRole('http://restate:8080', 'ws1', 'alice');
        expect(role).toBe('admin');
    });

    it('returns null when user is not a member', async () => {
        globalThis.fetch = vi.fn(async () => new Response(
            JSON.stringify({ isMember: false }),
            { status: 200 },
        )) as typeof fetch;

        const role = await workspaceMemberRole('http://restate:8080', 'ws1', 'stranger');
        expect(role).toBeNull();
    });

    it('returns null when the response is missing role', async () => {
        globalThis.fetch = vi.fn(async () => new Response(
            JSON.stringify({ isMember: true }),  // role omitted
            { status: 200 },
        )) as typeof fetch;

        const role = await workspaceMemberRole('http://restate:8080', 'ws1', 'alice');
        expect(role).toBeNull();
    });

    it('returns null on non-2xx responses (logged, not thrown)', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        globalThis.fetch = vi.fn(async () => new Response('server error', { status: 500 })) as typeof fetch;

        const role = await workspaceMemberRole('http://restate:8080', 'ws1', 'alice');
        expect(role).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
    });

    it('posts to the correct ingress URL', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(url), init: init ?? {} });
            return new Response(JSON.stringify({ isMember: true, role: 'member' }), { status: 200 });
        }) as typeof fetch;

        await workspaceMemberRole('http://restate:8080', 'ws-abc', 'alice');
        expect(calls[0]!.url).toBe('http://restate:8080/workspace/ws-abc/isMember');
        expect(calls[0]!.init.method).toBe('POST');
        expect(calls[0]!.init.body).toBe(JSON.stringify({ userId: 'alice' }));
    });

    it('encodes workspace ids with special characters', async () => {
        const calls: string[] = [];
        globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
            calls.push(String(url));
            return new Response(JSON.stringify({ isMember: false }), { status: 200 });
        }) as typeof fetch;

        await workspaceMemberRole('http://restate:8080/', 'ws/with spaces', 'alice');
        expect(calls[0]).toContain('/workspace/ws%2Fwith%20spaces/isMember');
    });
});
