/**
 * Production HTTP server (PLAN Phase 9).
 *
 * Replaces Vite's dev server in production. Handles three concerns:
 *
 *   1. Static file serving — serves the built client bundle from disk
 *      with correct MIME types, cache headers, and COOP/COEP for WASM.
 *
 *   2. Workspace resolution + meta tag injection — on HTML requests,
 *      runs the user's `syncengine.config.ts` resolver, hashes to a
 *      wsKey, lazy-provisions via Restate, and injects `<meta>` tags
 *      into the served `index.html`.
 *
 *   3. RPC proxy — forwards `/__syncengine/rpc/<entity>/<key>/<handler>`
 *      POSTs to the Restate ingress so the browser never needs the
 *      Restate URL directly.
 *
 * Pure Node.js — no Express, no Vite dependency.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

import {
    hashWorkspaceId,
    injectMetaTags,
} from '@syncengine/core/http';
import { GatewayServer } from './gateway/server.js';
import type {
    SyncengineConfig,
    SyncengineUser,
} from '@syncengine/core';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProductionServerConfig {
    /** Absolute path to the directory containing built static files. */
    staticDir: string;
    /** Raw HTML content of index.html (read once at startup). */
    indexHtml: string;
    /** Restate ingress URL for RPC proxying. */
    restateUrl: string;
    /** NATS WebSocket URL (injected into meta tags). */
    natsUrl: string;
    /** The loaded syncengine.config.ts default export. */
    appConfig: SyncengineConfig;
    /** Port to listen on. */
    port: number;
}

// ── MIME types ──────────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.map': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
};

function mimeType(filePath: string): string {
    return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// ── RPC validation (matches vite-plugin/actors.ts) ─────────────────────────

const NAME_REGEX = /^([a-zA-Z]|_[a-zA-Z0-9])[a-zA-Z0-9_]*$/;
const WORKSPACE_HEADER_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

// ── User extraction ────────────────────────────────────────────────────────

function extractUser(req: IncomingMessage): SyncengineUser {
    const url = req.url ?? '/';
    const parsed = new URL(url, 'http://localhost');
    const queryUser = parsed.searchParams.get('user') ?? 'anon';
    return { id: queryUser };
}

function buildRequest(req: IncomingMessage): Request {
    const url = req.url ?? '/';
    const fullUrl = new URL(url, `http://${req.headers.host ?? 'localhost'}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }
    return new Request(fullUrl, {
        method: req.method ?? 'GET',
        headers,
    });
}

// ── Lazy provisioning ──────────────────────────────────────────────────────

async function provisionWorkspace(
    wsKey: string,
    restateUrl: string,
): Promise<void> {
    const url = `${restateUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(wsKey)}/provision`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'default' }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(`workspace.provision(${wsKey}) → HTTP ${res.status}: ${text}`);
    }
}

// ── Request body helper ────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8') || '[]';
}

// ── Server factory ─────────────────────────────────────────────────────────

export function startHttpServer(config: ProductionServerConfig): void {
    const {
        staticDir,
        indexHtml,
        restateUrl,
        natsUrl,
        appConfig,
        port,
    } = config;

    const provisioned = new Set<string>();
    const provisioning = new Map<string, Promise<void>>();

    const ensureProvisioned = async (wsKey: string): Promise<void> => {
        if (provisioned.has(wsKey)) return;
        let inflight = provisioning.get(wsKey);
        if (!inflight) {
            inflight = provisionWorkspace(wsKey, restateUrl)
                .then(() => {
                    provisioned.add(wsKey);
                    provisioning.delete(wsKey);
                })
                .catch((err: unknown) => {
                    provisioning.delete(wsKey);
                    throw err;
                });
            provisioning.set(wsKey, inflight);
        }
        await inflight;
    };

    // COOP/COEP headers for SharedArrayBuffer (required by SQLite WASM)
    const securityHeaders: Record<string, string> = {
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
    };

    const natsInternalUrl = (config.natsUrl ?? 'ws://localhost:9222')
        .replace(/^ws/, 'nats')
        .replace(/:9222/, ':4222');
    const gateway = new GatewayServer({
        natsUrl: natsInternalUrl,
        restateUrl: config.restateUrl,
    });

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://localhost').pathname;

        try {
            // ── RPC proxy ──────────────────────────────────────────
            if (pathname.startsWith('/__syncengine/rpc/') && req.method === 'POST') {
                await handleRpc(req, res, restateUrl);
                return;
            }

            // ── Static files ───────────────────────────────────────
            if (pathname.startsWith('/assets/') || pathname === '/favicon.svg') {
                serveStatic(res, staticDir, pathname);
                return;
            }

            // ── HTML (SPA fallback) ────────────────────────────────
            // All other GET requests get the HTML with injected meta tags.
            if (req.method === 'GET' || req.method === 'HEAD') {
                await serveHtml(req, res, {
                    indexHtml,
                    natsUrl,
                    restateUrl,
                    appConfig,
                    ensureProvisioned,
                });
                return;
            }

            res.writeHead(405).end('Method Not Allowed');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[syncengine] ${req.method} ${url}: ${msg}`);
            if (!res.headersSent) {
                res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal Server Error');
            }
        }
    });

    server.on('upgrade', (req, socket, head) => {
        const pathname = (req.url ?? '').split('?')[0];
        if (pathname === '/gateway') {
            gateway.handleUpgrade(req, socket, head);
        } else {
            socket.destroy();
        }
    });

    server.listen(port, () => {
        console.log(`[syncengine] production server listening on :${port}`);
    });

    // ── Static file handler ────────────────────────────────────────────

    function serveStatic(
        res: ServerResponse,
        dir: string,
        pathname: string,
    ): void {
        // Prevent path traversal
        const safePath = pathname.replace(/\.\./g, '');
        const filePath = join(dir, safePath);
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
            res.writeHead(404).end('Not Found');
            return;
        }
        const content = readFileSync(filePath);
        const mime = mimeType(filePath);
        const headers: Record<string, string> = {
            'content-type': mime,
            'content-length': String(content.length),
            ...securityHeaders,
        };
        // Hashed assets get long-lived cache; non-hashed get revalidation
        if (pathname.startsWith('/assets/')) {
            headers['cache-control'] = 'public, max-age=31536000, immutable';
        }
        res.writeHead(200, headers).end(content);
    }

    // ── HTML handler with workspace resolution ─────────────────────────

    async function serveHtml(
        req: IncomingMessage,
        res: ServerResponse,
        opts: {
            indexHtml: string;
            natsUrl: string;
            restateUrl: string;
            appConfig: SyncengineConfig;
            ensureProvisioned: (wsKey: string) => Promise<void>;
        },
    ): Promise<void> {
        const user = extractUser(req);
        const request = buildRequest(req);

        let rawWorkspaceId: string;
        try {
            rawWorkspaceId = await opts.appConfig.workspaces.resolve({ request, user });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[syncengine] workspaces.resolve failed: ${msg}`);
            res.writeHead(500, { 'content-type': 'text/plain' })
                .end(`[syncengine] workspaces.resolve failed: ${msg}`);
            return;
        }

        const wsKey = hashWorkspaceId(rawWorkspaceId);

        try {
            await opts.ensureProvisioned(wsKey);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[syncengine] provision(${wsKey}) failed: ${msg}`);
        }

        const gatewayUrl = `ws://${req.headers.host}/gateway`;
        const html = injectMetaTags(opts.indexHtml, {
            workspaceId: wsKey,
            natsUrl: opts.natsUrl,
            restateUrl: opts.restateUrl,
            gatewayUrl,
        });

        const buf = Buffer.from(html, 'utf8');
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(buf.length),
            'cache-control': 'no-cache',
            ...securityHeaders,
        }).end(buf);
    }

    // ── RPC proxy handler ──────────────────────────────────────────────

    async function handleRpc(
        req: IncomingMessage,
        res: ServerResponse,
        restateIngressUrl: string,
    ): Promise<void> {
        const pathname = (req.url ?? '').split('?')[0]!;

        // Workflow RPC: /__syncengine/rpc/workflow/<name>/<invocationId>
        if (pathname.startsWith('/__syncengine/rpc/workflow/')) {
            const wfParts = pathname.slice('/__syncengine/rpc/workflow/'.length).split('/');
            if (wfParts.length !== 2) {
                res.writeHead(400).end('Expected /__syncengine/rpc/workflow/<name>/<invocationId>');
                return;
            }
            const [wfNameRaw, invocationIdRaw] = wfParts as [string, string];
            let wfName: string;
            let invocationId: string;
            try {
                wfName = decodeURIComponent(wfNameRaw);
                invocationId = decodeURIComponent(invocationIdRaw);
            } catch {
                res.writeHead(400).end('Malformed URL-encoded path component');
                return;
            }
            if (!NAME_REGEX.test(wfName)) {
                res.writeHead(400).end('Invalid workflow name');
                return;
            }
            // eslint-disable-next-line no-control-regex
            if (invocationId.length === 0 || invocationId.length > 512 || /[\x00-\x1f]/.test(invocationId)) {
                res.writeHead(400).end('Invalid invocationId');
                return;
            }

            const body = await readBody(req);

            const headerWs = req.headers['x-syncengine-workspace'];
            const headerWsValue = Array.isArray(headerWs) ? headerWs[0] : headerWs;
            let workspaceId: string;
            if (typeof headerWsValue === 'string' && headerWsValue.length > 0) {
                if (!WORKSPACE_HEADER_REGEX.test(headerWsValue)) {
                    res.writeHead(400).end('Invalid x-syncengine-workspace header');
                    return;
                }
                workspaceId = headerWsValue;
            } else {
                workspaceId = hashWorkspaceId('default');
            }

            const targetUrl =
                `${restateIngressUrl.replace(/\/+$/, '')}/workflow_${wfName}` +
                `/${encodeURIComponent(`${workspaceId}/${invocationId}`)}/run`;

            try {
                const upstream = await fetch(targetUrl, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body,
                });
                const text = await upstream.text();
                res.writeHead(upstream.status, {
                    'content-type': upstream.headers.get('content-type') || 'application/json',
                }).end(text);
            } catch (err) {
                res.writeHead(502, { 'content-type': 'application/json' }).end(
                    JSON.stringify({
                        message: `[syncengine] failed to reach Restate at ${targetUrl}: ${(err as Error).message}`,
                    }),
                );
            }
            return;
        }

        const pathParts = pathname.slice('/__syncengine/rpc/'.length).split('/');
        if (pathParts.length !== 3) {
            res.writeHead(400).end(`Expected /__syncengine/rpc/<entity>/<key>/<handler>`);
            return;
        }
        const [entityNameRaw, entityKeyRaw, handlerNameRaw] = pathParts as [string, string, string];

        let entityName: string;
        let entityKey: string;
        let handlerName: string;
        try {
            entityName = decodeURIComponent(entityNameRaw);
            entityKey = decodeURIComponent(entityKeyRaw);
            handlerName = decodeURIComponent(handlerNameRaw);
        } catch {
            res.writeHead(400).end('Malformed URL-encoded path component');
            return;
        }

        if (!NAME_REGEX.test(entityName) || !NAME_REGEX.test(handlerName)) {
            res.writeHead(400).end('Invalid entity or handler name');
            return;
        }
        // eslint-disable-next-line no-control-regex
        if (entityKey.length === 0 || entityKey.length > 512 || /[\/\\\x00-\x1f]/.test(entityKey)) {
            res.writeHead(400).end('Invalid entity key');
            return;
        }

        const body = await readBody(req);

        // Read workspace from header (sent by the client)
        const headerWs = req.headers['x-syncengine-workspace'];
        const headerWsValue = Array.isArray(headerWs) ? headerWs[0] : headerWs;
        let workspaceId: string;
        if (typeof headerWsValue === 'string' && headerWsValue.length > 0) {
            if (!WORKSPACE_HEADER_REGEX.test(headerWsValue)) {
                res.writeHead(400).end('Invalid x-syncengine-workspace header');
                return;
            }
            workspaceId = headerWsValue;
        } else {
            workspaceId = hashWorkspaceId('default');
        }

        const targetUrl =
            `${restateIngressUrl.replace(/\/+$/, '')}/entity_${entityName}` +
            `/${encodeURIComponent(`${workspaceId}/${entityKey}`)}` +
            `/${handlerName}`;

        try {
            const upstream = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
            });
            const text = await upstream.text();
            res.writeHead(upstream.status, {
                'content-type': upstream.headers.get('content-type') || 'application/json',
            }).end(text);
        } catch (err) {
            res.writeHead(502, { 'content-type': 'application/json' }).end(
                JSON.stringify({
                    message: `[syncengine] failed to reach Restate at ${targetUrl}: ${(err as Error).message}`,
                }),
            );
        }
    }
}
