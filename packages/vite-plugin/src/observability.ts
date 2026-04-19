// Vite-plugin observability boot + `.metrics.ts` discovery.
//
// Boots the OTel SDK when the dev server starts — so spans emitted by
// the Vite dev path (request handling, RPC proxy, framework seams
// when the user triggers an entity/workflow/webhook) flow to whatever
// OTLP endpoint the developer has configured.
//
// In dev, OTEL_EXPORTER_OTLP_ENDPOINT + a local collector (Jaeger,
// Tempo, etc.) gives you a live trace view without any code change.
// Disabling is a one-line `observability: { exporter: false }` in
// `syncengine.config.ts` — the SDK is then never loaded, keeping the
// dev server lean.
//
// File-based discovery: after SDK boot, this plugin walks `src/**/*.metrics.ts`
// and imports each via Vite's SSR loader. Module-level declarations
// like `export const orderPlaced = metric.counter(...)` get evaluated
// so any observable-gauge callbacks register with the meter provider
// immediately, matching the existing `.actor.ts` / `.workflow.ts` /
// `.webhook.ts` / `.heartbeat.ts` convention.
//
// On dev-server close we drain and shut down the SDK so buffered
// spans survive an `rs` / Ctrl-C restart.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Plugin, ViteDevServer } from 'vite';
import { bootSdk, type SdkHandle } from '@syncengine/observe';
import type { SyncengineConfig } from '@syncengine/core';

import { loadConfig } from './workspaces.ts';

export function observabilityPlugin(): Plugin {
    let handle: SdkHandle | null = null;

    return {
        name: 'syncengine:observability',
        apply: 'serve',

        async configureServer(server) {
            const viteRoot = server.config.root;
            let config: SyncengineConfig;
            try {
                config = await loadConfig(viteRoot, server, {});
            } catch {
                // Config load errors are reported elsewhere (workspacesPlugin
                // surfaces the real error). Fall back to env-driven defaults
                // here so the SDK boot doesn't masquerade as the config
                // loader's failure.
                config = { workspaces: { resolve: () => 'default' } };
            }

            handle = await bootSdk({ config: config.observability });

            if (handle.enabled) {
                server.config.logger.info(
                    '[syncengine] observability: OTel SDK ready',
                    { timestamp: true },
                );
            }

            // Discover and SSR-load `.metrics.ts` files so module-level
            // declarations (e.g. observable-gauge registrations) evaluate
            // at boot. Happens regardless of enabled/disabled — in the
            // disabled path the metric factory is a no-op, but we still
            // want the modules loaded so top-level exports work when
            // consumer code imports them.
            const srcDir = resolve(viteRoot, 'src');
            const metricsFiles = discoverMetricsFiles(srcDir);
            if (metricsFiles.length > 0) {
                await loadMetricsFiles(server, metricsFiles);
                server.config.logger.info(
                    `[syncengine] observability: loaded ${metricsFiles.length} *.metrics.ts file(s)`,
                    { timestamp: true },
                );
            }

            // Drain telemetry when the dev server shuts down — otherwise
            // spans from the last few requests buffered in the batch
            // processor are lost on Ctrl-C.
            server.httpServer?.once('close', () => {
                void handle?.shutdown().catch(() => {
                    // Swallow — we're in the shutdown path, nothing to
                    // do with a late shutdown error.
                });
            });
        },

        async closeBundle() {
            // For `vite build`, apply: 'serve' prevents this plugin from
            // running, so this is a belt-and-suspenders cleanup in case
            // the apply gate is ever relaxed.
            if (handle !== null) {
                await handle.shutdown();
                handle = null;
            }
        },
    };
}

/** Walk `srcDir` and collect every `*.metrics.ts` path. Intentionally
 *  a small queue-based walk (no glob dep) mirroring the `.actor.ts`
 *  discovery in `actors.ts`. Exported for tests; stays internal to
 *  the package otherwise. */
export function discoverMetricsFiles(srcDir: string): string[] {
    const out: string[] = [];
    if (!existsSync(srcDir)) return out;
    const queue: string[] = [srcDir];
    while (queue.length > 0) {
        const dir = queue.shift()!;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of entries) {
            if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
            const full = join(dir, name);
            let st;
            try { st = statSync(full); } catch { continue; }
            if (st.isDirectory()) {
                queue.push(full);
            } else if (st.isFile() && name.endsWith('.metrics.ts')) {
                out.push(full);
            }
        }
    }
    return out;
}

/** SSR-load each file so module-level declarations evaluate. Errors
 *  are logged but don't abort the dev server — a bad metrics file
 *  shouldn't block traces + the rest of the app. */
async function loadMetricsFiles(
    server: ViteDevServer,
    files: readonly string[],
): Promise<void> {
    for (const file of files) {
        try {
            await server.ssrLoadModule(file);
        } catch (err) {
            server.config.logger.error(
                `[syncengine] observability: failed to load ${file}: ${(err as Error).message}`,
            );
        }
    }
}
