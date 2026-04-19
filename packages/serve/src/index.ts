#!/usr/bin/env bun
/**
 * `syncengine serve` — production HTTP server.
 *
 * Entry point. Boots:
 *   1. parseFlags — argv → validated Flags (design §8)
 *   2. env check — required SYNCENGINE_* vars present
 *   3. dynamic-import `<distDir>/server/config.mjs` → user's config
 *   4. createServer — composes static + HTML + health + ready
 *   5. Bun.serve — listen on host:port
 *   6. SIGTERM handler — drain inflight, exit gracefully
 *   7. markReady — flips /_ready to 200
 *
 * Compiled with:
 *   bun build --compile --minify --sourcemap=none \
 *     --target=bun-linux-x64 \
 *     --outfile=dist/syncengine-serve \
 *     src/index.ts
 */

import { resolve as resolvePath, join } from 'node:path';
import { existsSync } from 'node:fs';
import { errors, CliCode, formatError } from '@syncengine/core';
import type { SyncengineConfig } from '@syncengine/core';
import { parseFlags } from './flags.ts';
import type { Flags } from './flags.ts';
import { createServer } from './server.ts';
import { createLogger } from './logger.ts';
import type { Logger } from './logger.ts';
import { createShutdownController } from './shutdown.ts';
import { BunGateway } from './gateway.ts';

// ── Boot ───────────────────────────────────────────────────────────────────

async function main(argv: readonly string[]): Promise<void> {
    // Orchestrator healthcheck path — the distroless edge image has no
    // curl/wget/Node, only the compiled binary itself. A one-shot
    // `syncengine-serve --health-check` fetches /_health on the port
    // this process listens on and exits 0/1 so HEALTHCHECK directives
    // remain self-contained.
    if (argv.includes('--health-check')) {
        await runHealthCheck();
        return;
    }

    let flags: Flags;
    try {
        flags = parseFlags(argv);
    } catch (err) {
        process.stderr.write(
            (err instanceof Error ? err.message : String(err)) + '\n',
        );
        process.exit(2);
    }

    const logger = createLogger({ level: flags.logLevel, format: flags.logFormat });

    // Required env vars (internal — how this process reaches infra).
    const natsUrl = process.env.SYNCENGINE_NATS_URL;
    const restateUrl = process.env.SYNCENGINE_RESTATE_URL;
    // Optional overrides — what the BROWSER uses. Set in split-network
    // deploys where the edge reaches nats/restate via compose DNS but
    // the browser reaches them via the host's published ports.
    const publicNatsUrl = process.env.SYNCENGINE_NATS_PUBLIC_URL;
    const publicRestateUrl = process.env.SYNCENGINE_RESTATE_PUBLIC_URL;
    // The edge always hosts an in-process `/gateway` WebSocket (see
    // BunGateway below). Advertising it as same-origin by default
    // means `connectGateway()` wins over `connectNats()` — the browser
    // never touches NATS directly. SYNCENGINE_GATEWAY_URL overrides
    // for operators who front the edge with a CDN or want to steer
    // clients at a dedicated gateway host.
    const gatewayUrl = process.env.SYNCENGINE_GATEWAY_URL ?? '/gateway';
    if (!natsUrl || !restateUrl) {
        const err = errors.cli(CliCode.ENV_MISSING, {
            message:
                `syncengine serve requires SYNCENGINE_NATS_URL and SYNCENGINE_RESTATE_URL`,
            hint: `Set these in your deployment environment.`,
        });
        process.stderr.write(formatError(err, { color: process.stderr.isTTY }) + '\n');
        process.exit(1);
    }

    // Locate the build output.
    const distDir = resolvePath(flags.distDir);
    if (!existsSync(distDir)) {
        const err = errors.cli(CliCode.BUILD_OUTPUT_MISSING, {
            message: `distDir ${distDir} does not exist`,
            hint: `Run \`syncengine build\` first, or pass the correct path as the first argument.`,
        });
        process.stderr.write(formatError(err, { color: process.stderr.isTTY }) + '\n');
        process.exit(1);
    }

    // Load the compiled config emitted by `syncengine build`.
    const configPath = join(distDir, 'server', 'config.mjs');
    if (!existsSync(configPath)) {
        const err = errors.cli(CliCode.BUILD_OUTPUT_MISSING, {
            message: `missing ${configPath}`,
            hint: `Re-run \`syncengine build\` — this file is emitted by the build step.`,
        });
        process.stderr.write(formatError(err, { color: process.stderr.isTTY }) + '\n');
        process.exit(1);
    }
    const config = (await import(configPath)).default as SyncengineConfig;

    // Build the server fetch handler. --dev-errors / --no-dev-errors
    // overrides the NODE_ENV fallback — useful for staging deploys
    // where operators want Restate stack traces without flipping env.
    const devMode = flags.devErrors !== null
        ? flags.devErrors
        : process.env.NODE_ENV !== 'production';
    const handle = await createServer({
        distDir,
        config,
        natsUrl,
        restateUrl,
        ...(publicNatsUrl ? { publicNatsUrl } : {}),
        ...(publicRestateUrl ? { publicRestateUrl } : {}),
        ...(gatewayUrl ? { gatewayUrl } : {}),
        assetsPrefix: flags.assetsPrefix,
        resolveTimeoutMs: flags.resolveTimeoutMs,
        devMode,
    });

    // Track inflight requests so SIGTERM can drain them.
    const shutdown = createShutdownController({ drainMs: flags.shutdownDrainMs });

    // The gateway is in-process — no proxy, no second service. A
    // single GatewayCore instance owns the WebSocket↔NATS bridge for
    // every connected browser.
    const gateway = new BunGateway({ natsUrl, restateUrl });

    const server = Bun.serve({
        port: flags.port,
        hostname: flags.host,
        maxRequestBodySize: flags.maxBodyBytes,
        async fetch(req: Request): Promise<Response | undefined> {
            const t0 = performance.now();
            // Hijack /gateway for WebSocket upgrade before the fetch
            // path sees it. When upgrade succeeds, Bun takes over and
            // this handler returns `undefined`.
            if (gateway.tryUpgrade(req, server as unknown as Parameters<typeof gateway.tryUpgrade>[1])) {
                logger.info({
                    event: 'gateway.upgrade',
                    path: new URL(req.url).pathname,
                    duration_ms: Math.round((performance.now() - t0) * 100) / 100,
                });
                return undefined;
            }
            const work = handle.fetch(req);
            return shutdown.track(work).then((res) => {
                logRequest(logger, req, res, t0);
                return res;
            });
        },
        websocket: gateway.websocketHandlers(),
    });

    logger.info({
        event: 'server.listening',
        host: flags.host,
        port: flags.port,
        distDir,
        logLevel: flags.logLevel,
    });

    // Mark ready — accept traffic.
    handle.markReady();

    // Install SIGTERM / SIGINT handlers.
    installShutdownHandlers(server, shutdown, logger);

    // Keep the process alive. Bun.serve holds the event loop open on
    // its own; this Promise is here for clarity.
    await new Promise<void>(() => {
        /* never resolves — exit is driven by signals */
    });
}

function logRequest(
    logger: Logger,
    req: Request,
    res: Response,
    t0: number,
): void {
    const url = new URL(req.url);
    const status = res.status;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger[level]({
        event: eventFor(url.pathname, status),
        request_id: res.headers.get('x-request-id'),
        method: req.method,
        path: url.pathname,
        status,
        duration_ms: Math.round((performance.now() - t0) * 100) / 100,
    });
}

function eventFor(path: string, status: number): string {
    if (path === '/_health') return 'health.ok';
    if (path === '/_ready') return status === 200 ? 'ready.ok' : 'ready.fail';
    // Static assets usually have an extension; HTML is the rest.
    const isStatic = /\.[a-zA-Z0-9]+$/.test(path);
    const kind = isStatic ? 'static' : 'html';
    if (status >= 500) return `${kind}.err`;
    if (status === 404) return `${kind}.404`;
    if (status === 405) return `${kind}.405`;
    return `${kind}.ok`;
}

/**
 * One-shot HTTP probe against this process's own /_health endpoint.
 * Exits 0 if 2xx, 1 otherwise. Used by the Docker HEALTHCHECK in the
 * distroless edge image where no separate probe tooling is available.
 *
 * Reads the port from $HTTP_PORT (aligning with the Dockerfile's
 * ENV HTTP_PORT=3000); if unset, falls back to the spec default.
 */
async function runHealthCheck(): Promise<void> {
    const port = process.env.HTTP_PORT ?? '3000';
    try {
        const res = await fetch(`http://127.0.0.1:${port}/_health`, {
            signal: AbortSignal.timeout(2000),
        });
        process.exit(res.ok ? 0 : 1);
    } catch {
        process.exit(1);
    }
}

let signalHandlersInstalled = false;

function installShutdownHandlers(
    server: ReturnType<typeof Bun.serve>,
    shutdown: ReturnType<typeof createShutdownController>,
    logger: Logger,
): void {
    if (signalHandlersInstalled) return;
    signalHandlersInstalled = true;

    let hardExitQueued = false;

    const onSignal = async (sig: NodeJS.Signals): Promise<void> => {
        if (shutdown.isDraining()) {
            if (hardExitQueued) return;
            hardExitQueued = true;
            logger.warn({ event: 'shutdown.force', signal: sig });
            process.exit(130);
        }

        logger.info({ event: 'shutdown.begin', signal: sig });
        // Stop accepting new connections.
        server.stop(false);
        const result = await shutdown.drain();
        logger.info({ event: 'shutdown.done', ...result });
        process.exit(0);
    };

    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
}

// ── Run ────────────────────────────────────────────────────────────────────

// argv[0] = bun executable, argv[1] = script path. User args start at [2].
await main(process.argv.slice(2));
