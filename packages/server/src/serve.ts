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
import {
    resolveWorkspaceId,
    resolveWorkflowTarget,
    resolveHeartbeatTarget,
    resolveEntityTarget,
    isRpcError,
} from '@syncengine/http-core';
import { GatewayServer } from './gateway/server.js';
import type {
    SyncengineConfig,
    SyncengineUser,
} from '@syncengine/core';
import { provisionWorkspace } from '@syncengine/core/http';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProductionServerConfig {
    /** Absolute path to the directory containing built static files. */
    staticDir: string;
    /** Raw HTML content of index.html (read once at startup). */
    indexHtml: string;
    /** Restate ingress URL for server-side RPC proxying. Always the
     *  network address reachable from INSIDE this process. */
    restateUrl: string;
    /** NATS URL used server-side. Always the address reachable from
     *  inside this process. */
    natsUrl: string;
    /** Optional override for the Restate URL injected into HTML. When
     *  unset, `restateUrl` is used. Needed when the browser reaches
     *  Restate on a different address than the server does (e.g.
     *  Docker: server=http://restate:8080, browser=http://localhost:18080). */
    publicRestateUrl?: string;
    /** Optional override for the NATS URL injected into HTML. Same
     *  rationale as publicRestateUrl. */
    publicNatsUrl?: string;
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
        publicRestateUrl,
        publicNatsUrl,
        appConfig,
        port,
    } = config;

    const provisioned = new Set<string>();
    const provisioning = new Map<string, Promise<void>>();

    const ensureProvisioned = async (wsKey: string): Promise<void> => {
        if (provisioned.has(wsKey)) return;
        let inflight = provisioning.get(wsKey);
        if (!inflight) {
            inflight = provisionWorkspace(restateUrl, wsKey)
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
                    ...(publicNatsUrl ? { publicNatsUrl } : {}),
                    ...(publicRestateUrl ? { publicRestateUrl } : {}),
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
            publicNatsUrl?: string;
            publicRestateUrl?: string;
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

        const wsProto = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
        const gatewayUrl = `${wsProto}://${req.headers.host}/gateway`;
        const html = injectMetaTags(opts.indexHtml, {
            workspaceId: wsKey,
            natsUrl: opts.publicNatsUrl ?? opts.natsUrl,
            restateUrl: opts.publicRestateUrl ?? opts.restateUrl,
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
        const isWorkflow = pathname.startsWith('/__syncengine/rpc/workflow/');
        const isHeartbeat = pathname.startsWith('/__syncengine/rpc/heartbeat/');

        // Resolve workspace (shared validation)
        const wsResult = resolveWorkspaceId(
            req.headers['x-syncengine-workspace'],
            () => hashWorkspaceId('default'),
        );
        if (isRpcError(wsResult)) {
            res.writeHead(wsResult.status).end(wsResult.message);
            return;
        }

        // Resolve target URL (shared validation + URL construction)
        const target = isHeartbeat
            ? resolveHeartbeatTarget(pathname, wsResult, restateIngressUrl)
            : isWorkflow
                ? resolveWorkflowTarget(pathname, wsResult, restateIngressUrl)
                : resolveEntityTarget(pathname, wsResult, restateIngressUrl);
        if (isRpcError(target)) {
            res.writeHead(target.status).end(target.message);
            return;
        }

        // Read body (raw http)
        const body = await readBody(req);

        // Proxy to Restate
        try {
            const upstream = await fetch(target.url, {
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
                    message: `[syncengine] failed to reach Restate at ${target.url}: ${(err as Error).message}`,
                }),
            );
        }
    }
}
