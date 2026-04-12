import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProvisionCache } from '@syncengine/http-core';
import { provisionWorkspace } from '@syncengine/core/http';
import type { SyncengineConfig } from '@syncengine/core';
import { createStaticHandler } from './static.ts';
import { createHtmlHandler } from './html.ts';
import { healthHandler, createReadinessHandler } from './health.ts';

export interface CreateServerOptions {
    readonly distDir: string;
    readonly config: SyncengineConfig;
    readonly natsUrl: string;
    readonly restateUrl: string;
    readonly gatewayUrl?: string;
    readonly assetsPrefix?: string;
    readonly resolveTimeoutMs?: number;
    readonly devMode?: boolean;
    /** Override the default ProvisionCache. Used by tests to inject a
     *  no-op provisioner so we don't try to reach a real Restate. */
    readonly provisionCache?: ProvisionCache;
}

export interface ServerHandle {
    /** Top-level fetch handler — pass straight to `Bun.serve({ fetch })`. */
    readonly fetch: (req: Request) => Promise<Response>;
    /** Flip the readiness probe to 200. Call after boot + any initial
     *  warmup completes. */
    readonly markReady: () => void;
}

/**
 * Wire together the four route handlers (static, HTML, health, ready)
 * into a single fetch function. No networking — just routing. The
 * caller passes this to `Bun.serve({ fetch })` in production, or invokes
 * it directly in tests.
 */
export async function createServer(opts: CreateServerOptions): Promise<ServerHandle> {
    const indexHtml = readFileSync(join(opts.distDir, 'index.html'), 'utf8');

    const provisionCache = opts.provisionCache ?? new ProvisionCache((wsKey) =>
        provisionWorkspace(opts.restateUrl, wsKey),
    );

    const staticHandler = await createStaticHandler({
        distDir: opts.distDir,
        assetsPrefix: opts.assetsPrefix,
    });

    const htmlHandler = createHtmlHandler({
        indexHtml,
        config: opts.config,
        provisionCache,
        natsUrl: opts.natsUrl,
        restateUrl: opts.restateUrl,
        ...(opts.gatewayUrl ? { gatewayUrl: opts.gatewayUrl } : {}),
        devMode: opts.devMode ?? false,
        ...(opts.resolveTimeoutMs !== undefined
            ? { resolveTimeoutMs: opts.resolveTimeoutMs }
            : {}),
    });

    const readiness = createReadinessHandler();

    return {
        async fetch(req: Request): Promise<Response> {
            const url = new URL(req.url);
            const path = url.pathname;

            if (path === '/_health') return healthHandler(req);
            if (path === '/_ready') return readiness.handler(req);

            // Static handler returns null for paths that aren't its
            // business (no extension, non-asset-prefix, or wrong
            // method). Fall through to HTML in that case.
            const staticRes = await staticHandler(req);
            if (staticRes) return staticRes;

            return htmlHandler(req);
        },
        markReady: readiness.markReady,
    };
}
