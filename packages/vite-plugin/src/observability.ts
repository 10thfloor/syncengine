// Vite-plugin observability boot.
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
// On dev-server close we drain and shut down the SDK so buffered
// spans survive an `rs` / Ctrl-C restart.

import type { Plugin } from 'vite';
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
