import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createStaticHandler } from '../static.ts';

const FIXTURE = '/tmp/se-static-fixture';
const HASHED_JS = 'app-abcdef12.js';
const PLAIN_CSS = 'styles.css';
const NESTED_ASSET = 'assets/logo.png';

beforeAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(join(FIXTURE, 'assets'), { recursive: true });
    writeFileSync(join(FIXTURE, HASHED_JS), 'console.log("hashed");');
    writeFileSync(join(FIXTURE, PLAIN_CSS), 'body { color: red; }');
    writeFileSync(join(FIXTURE, NESTED_ASSET), 'PNG-BYTES');
});

afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
});

describe('createStaticHandler', () => {
    it('serves an existing file with correct content-type and status', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const res = await handler(new Request(`http://localhost/${HASHED_JS}`));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('javascript');
        const body = await res.text();
        expect(body).toContain('hashed');
    });

    it('maps well-known extensions correctly', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const css = await handler(new Request(`http://localhost/${PLAIN_CSS}`));
        expect(css.headers.get('content-type')).toContain('css');
    });

    it('serves nested paths under distDir', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const res = await handler(new Request(`http://localhost/${NESTED_ASSET}`));
        expect(res.status).toBe(200);
    });

    it('returns 404 for nonexistent paths', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const res = await handler(new Request('http://localhost/does-not-exist.js'));
        expect(res.status).toBe(404);
    });

    it('rejects URL-encoded traversal attempts with 404', async () => {
        // Paths like `/../etc/passwd` are already normalized away by
        // the URL parser before our handler runs — pathname becomes
        // `/etc/passwd` (a harmless miss). URL-encoded slashes %2F
        // survive that normalization and reach the handler; those are
        // what we actually have to guard against.
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const res = await handler(
            new Request('http://localhost/..%2F..%2Fetc%2Fpasswd.js'),
        );
        expect(res?.status).toBe(404);
    });

    it('never serves content resolving outside distDir', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        for (const url of [
            'http://localhost/..%2F..%2Fetc%2Fpasswd.js',
            'http://localhost/..%5C..%5Cetc%5Cpasswd.js',
        ]) {
            const res = await handler(new Request(url));
            // Either null (punted to HTML handler) or 404 — never a
            // 200 with file content.
            if (res) expect(res.status).not.toBe(200);
        }
    });

    it('applies Cache-Control: immutable to hashed assets', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const res = await handler(new Request(`http://localhost/${HASHED_JS}`));
        const cc = res.headers.get('cache-control') ?? '';
        expect(cc).toContain('immutable');
        expect(cc).toContain('max-age=31536000');
    });

    it('applies Cache-Control: no-cache to non-hashed assets', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const res = await handler(new Request(`http://localhost/${PLAIN_CSS}`));
        const cc = res.headers.get('cache-control') ?? '';
        expect(cc).toContain('no-cache');
    });

    it('emits a stable ETag per file', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const res1 = await handler(new Request(`http://localhost/${HASHED_JS}`));
        const res2 = await handler(new Request(`http://localhost/${HASHED_JS}`));
        const e1 = res1.headers.get('etag');
        const e2 = res2.headers.get('etag');
        expect(e1).toBeTruthy();
        expect(e1).toBe(e2);
        expect(e1).toMatch(/^(W\/)?"[a-f0-9]+"$/);
    });

    it('returns 304 when If-None-Match matches', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const first = await handler(new Request(`http://localhost/${HASHED_JS}`));
        const etag = first.headers.get('etag')!;
        const second = await handler(
            new Request(`http://localhost/${HASHED_JS}`, {
                headers: { 'if-none-match': etag },
            }),
        );
        expect(second.status).toBe(304);
        // 304 responses have empty bodies
        expect(await second.text()).toBe('');
    });

    it('returns 200 when If-None-Match does not match', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const res = await handler(
            new Request(`http://localhost/${HASHED_JS}`, {
                headers: { 'if-none-match': '"stale-tag"' },
            }),
        );
        expect(res.status).toBe(200);
    });

    it('returns null for a clearly-non-static path (so HTML handler can take it)', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        // No file extension → not a static path
        const miss = await handler(new Request('http://localhost/dashboard'));
        expect(miss).toBeNull();
    });

    it('returns null for the root path /', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const miss = await handler(new Request('http://localhost/'));
        expect(miss).toBeNull();
    });

    it('rejects non-GET/HEAD with null (HTML handler will 405)', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const res = await handler(
            new Request(`http://localhost/${HASHED_JS}`, { method: 'POST' }),
        );
        expect(res).toBeNull();
    });

    it('HEAD request returns 200 + headers but no body', async () => {
        const handler = await createStaticHandler({ distDir: FIXTURE });
        const res = await handler(
            new Request(`http://localhost/${HASHED_JS}`, { method: 'HEAD' }),
        );
        expect(res?.status).toBe(200);
        expect(res?.headers.get('etag')).toBeTruthy();
        const body = await res?.text();
        expect(body).toBe('');
    });
});
