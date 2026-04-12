/**
 * Unit tests for the pure helpers in `workspaces.ts`. The
 * `workspacesPlugin` factory itself is an integration concern that
 * needs a live Vite dev server, so it's covered by the browser smoke
 * tests in PLAN Phase 8 verification rather than here. These tests
 * pin down the contract of the helper functions so a future refactor
 * can't silently break wsKey derivation, meta-tag injection, or
 * request marshalling.
 */

import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';

import { hashWorkspaceId, injectMetaTags } from '@syncengine/core/http';
import { extractUser, buildRequest, devAuthShim } from '../workspaces';
import type { SyncengineConfig } from '@syncengine/core';

// Connect's IncomingMessage type is a thin wrapper over Node's
// IncomingMessage. We build minimal stubs that satisfy only the
// fields the helpers actually read (`url`, `method`, `headers`).
function mockReq(partial: Partial<IncomingMessage>): IncomingMessage {
    return {
        url: '/',
        method: 'GET',
        headers: {},
        ...partial,
    } as IncomingMessage;
}

describe('hashWorkspaceId', () => {
    it('returns a 16-character hex string', () => {
        const result = hashWorkspaceId('user:alice');
        expect(result).toMatch(/^[a-f0-9]{16}$/);
    });

    it('is deterministic — same input yields same output', () => {
        const a = hashWorkspaceId('user:alice');
        const b = hashWorkspaceId('user:alice');
        expect(a).toBe(b);
    });

    it('different inputs yield different hashes', () => {
        const alice = hashWorkspaceId('user:alice');
        const bob = hashWorkspaceId('user:bob');
        expect(alice).not.toBe(bob);
    });

    it('matches the known SHA-256 truncation for "user:alice"', () => {
        // This is a golden-value test: if it fails, the wsKey
        // derivation scheme changed and every previously-provisioned
        // workspace in production is now orphaned. That's intentional
        // — force the change to be explicit.
        expect(hashWorkspaceId('user:alice')).toBe('dabd1db8d35ab131');
    });

    it('matches the hash for the default resolver output', () => {
        // The actors.ts RPC fallback uses hashWorkspaceId('default').
        // If this golden value changes, the fallback path breaks.
        expect(hashWorkspaceId('default')).toBe('37a8eec1ce19687d');
    });

    it('handles empty strings without crashing', () => {
        expect(hashWorkspaceId('')).toMatch(/^[a-f0-9]{16}$/);
    });

    it('handles unicode identifiers', () => {
        const a = hashWorkspaceId('user:ålice');
        const b = hashWorkspaceId('user:alice');
        expect(a).toMatch(/^[a-f0-9]{16}$/);
        expect(a).not.toBe(b);
    });

    it('handles very long identifiers by always truncating to 16 chars', () => {
        const longId = 'org:' + 'x'.repeat(10_000);
        expect(hashWorkspaceId(longId)).toMatch(/^[a-f0-9]{16}$/);
    });
});

describe('injectMetaTags', () => {
    const values = {
        workspaceId: 'abc123',
        natsUrl: 'ws://localhost:9222',
        restateUrl: 'http://localhost:8080',
    };

    it('injects three meta tags before </head>', () => {
        const html = '<html><head><title>t</title></head><body></body></html>';
        const out = injectMetaTags(html, values);
        expect(out).toContain('name="syncengine-workspace-id"');
        expect(out).toContain('content="abc123"');
        expect(out).toContain('name="syncengine-nats-url"');
        expect(out).toContain('content="ws://localhost:9222"');
        expect(out).toContain('name="syncengine-restate-url"');
        expect(out).toContain('content="http://localhost:8080"');
    });

    it('places the meta tags inside <head>, before </head>', () => {
        const html = '<html><head><title>t</title></head><body></body></html>';
        const out = injectMetaTags(html, values);
        const headOpen = out.indexOf('<head>');
        const headClose = out.indexOf('</head>');
        const metaIdx = out.indexOf('syncengine-workspace-id');
        expect(metaIdx).toBeGreaterThan(headOpen);
        expect(metaIdx).toBeLessThan(headClose);
    });

    it('is idempotent — second call is a no-op', () => {
        const html = '<html><head></head></html>';
        const once = injectMetaTags(html, values);
        const twice = injectMetaTags(once, values);
        expect(once).toBe(twice);
        // And there's still only ONE set of tags
        const count = (once.match(/name="syncengine-workspace-id"/g) ?? []).length;
        expect(count).toBe(1);
    });

    it('is idempotent even when called with different values', () => {
        // This is a soft invariant: if someone already injected meta
        // tags for a different workspace, we should NOT stomp them.
        // Otherwise an HMR-triggered re-render could leak workspace
        // ids across tabs inside the same server process.
        const html = '<html><head></head></html>';
        const first = injectMetaTags(html, values);
        const second = injectMetaTags(first, {
            workspaceId: 'different',
            natsUrl: 'ws://other',
            restateUrl: 'http://other',
        });
        expect(second).toBe(first);
        expect(second).not.toContain('different');
    });

    it('escapes HTML entities in attribute values', () => {
        const out = injectMetaTags('<html><head></head></html>', {
            workspaceId: 'foo"bar<baz>',
            natsUrl: 'ws://a&b',
            restateUrl: 'http://x',
        });
        expect(out).toContain('foo&quot;bar&lt;baz&gt;');
        expect(out).toContain('ws://a&amp;b');
        // And the raw characters are NOT present inside a meta tag
        expect(out).not.toMatch(/content="[^"]*"bar/);
    });

    it('falls back to prepending after <head> if </head> is missing', () => {
        const html = '<html><head><title>t</title>';
        const out = injectMetaTags(html, values);
        expect(out).toContain('syncengine-workspace-id');
        // Must still land inside <head>
        expect(out.indexOf('<head>')).toBeLessThan(out.indexOf('syncengine-workspace-id'));
    });
});

describe('extractUser', () => {
    it('returns { id: "anon" } when no query param is present', () => {
        const user = extractUser(mockReq({ url: '/' }));
        expect(user.id).toBe('anon');
    });

    it('reads the `user` query param', () => {
        const user = extractUser(mockReq({ url: '/?user=alice' }));
        expect(user.id).toBe('alice');
    });

    it('handles URL-encoded values', () => {
        const user = extractUser(mockReq({ url: '/?user=alice%40example.com' }));
        expect(user.id).toBe('alice@example.com');
    });

    it('uses the first occurrence when `user` appears multiple times', () => {
        const user = extractUser(mockReq({ url: '/?user=alice&user=bob' }));
        expect(user.id).toBe('alice');
    });

    it('falls back to anon when req.url is undefined', () => {
        const user = extractUser(mockReq({ url: undefined }));
        expect(user.id).toBe('anon');
    });

    it('ignores other query params', () => {
        const user = extractUser(mockReq({ url: '/?foo=1&user=alice&bar=2' }));
        expect(user.id).toBe('alice');
    });
});

describe('buildRequest', () => {
    it('produces a Request with the incoming URL and host', () => {
        const req = buildRequest(mockReq({
            url: '/dashboard?x=1',
            headers: { host: 'example.com' },
        }));
        expect(req.url).toBe('http://example.com/dashboard?x=1');
    });

    it('copies single-valued headers verbatim', () => {
        const req = buildRequest(mockReq({
            url: '/',
            headers: {
                host: 'localhost',
                cookie: 'session=abc123',
                authorization: 'Bearer xyz',
            },
        }));
        expect(req.headers.get('cookie')).toBe('session=abc123');
        expect(req.headers.get('authorization')).toBe('Bearer xyz');
    });

    it('joins array-valued headers with commas', () => {
        // Node represents multi-value headers as arrays (e.g. set-cookie).
        const req = buildRequest(mockReq({
            url: '/',
            headers: {
                host: 'localhost',
                'x-forwarded-for': ['1.2.3.4', '5.6.7.8'],
            },
        }));
        expect(req.headers.get('x-forwarded-for')).toBe('1.2.3.4, 5.6.7.8');
    });

    it('defaults method to GET', () => {
        const req = buildRequest(mockReq({ url: '/', method: undefined }));
        expect(req.method).toBe('GET');
    });

    it('preserves non-GET methods', () => {
        const req = buildRequest(mockReq({ url: '/', method: 'POST' }));
        expect(req.method).toBe('POST');
    });

    it('falls back to localhost when host header is missing', () => {
        const req = buildRequest(mockReq({
            url: '/',
            headers: {},
        }));
        expect(req.url).toMatch(/^http:\/\/localhost\//);
    });
});

describe('devAuthShim', () => {
    const baseConfig: SyncengineConfig = {
        workspaces: { resolve: () => 'default' },
    };

    it('returns the user config unchanged when auth is already declared', () => {
        const userAuth = {
            verify: async () => ({ id: 'from-user-verify' }),
        };
        const userConfig: SyncengineConfig = {
            ...baseConfig,
            auth: userAuth,
        };

        const shimmed = devAuthShim(userConfig);
        expect(shimmed).toBe(userConfig);          // identity: no cloning
        expect(shimmed.auth).toBe(userAuth);       // same object
    });

    it('injects a ?user=-reading verify when auth is absent', async () => {
        const shimmed = devAuthShim(baseConfig);
        expect(shimmed.auth).toBeDefined();

        const user = await shimmed.auth!.verify({
            request: new Request('http://localhost/?user=alice'),
        });
        expect(user).toEqual({ id: 'alice' });
    });

    it('injected verify falls back to id=anon when no ?user= param', async () => {
        const shimmed = devAuthShim(baseConfig);
        const user = await shimmed.auth!.verify({
            request: new Request('http://localhost/'),
        });
        expect(user).toEqual({ id: 'anon' });
    });

    it('injected verify reads the user param, not other query params', async () => {
        const shimmed = devAuthShim(baseConfig);
        const user = await shimmed.auth!.verify({
            request: new Request('http://localhost/?foo=1&user=bob&bar=2'),
        });
        expect(user).toEqual({ id: 'bob' });
    });

    it('preserves the rest of the user config verbatim', () => {
        const userConfig: SyncengineConfig = {
            workspaces: {
                resolve: ({ user }) => `user:${user.id}`,
            },
        };
        const shimmed = devAuthShim(userConfig);
        expect(shimmed.workspaces).toBe(userConfig.workspaces);
    });
});
