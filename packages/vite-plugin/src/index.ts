/**
 * `@syncengine/vite-plugin` — Vite plugin for the syncengine framework.
 *
 * Current responsibility (Phase 3): expose a virtual module
 * `virtual:syncengine/runtime-config` that `@syncengine/client` imports to
 * discover the NATS websocket URL, Restate ingress URL, workspace ID, and
 * auth token for the running environment.
 *
 * In dev: the plugin reads `.syncengine/dev/runtime.json` written by
 * `syncengine dev`. When the file changes (e.g. the orchestrator restarts
 * with different ports), the virtual module is invalidated and Vite HMR
 * reloads the affected modules.
 *
 * In production: the plugin reads from environment variables prefixed with
 * `SYNCENGINE_`, populated by the deployment target. No filesystem state
 * required.
 *
 * Later phases of this plugin (4-6) will add:
 *   - .actor.ts file discovery
 *   - Client/server module graph splitting
 *   - Typed RPC codegen for handler signatures
 *   - Auto-registration of generated Restate services
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import type { Plugin, ViteDevServer } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

import { actorsPlugin, type ActorsPluginOptions } from './actors.ts';
import { devtoolsPlugin } from './devtools/devtools-plugin.ts';
import { observabilityPlugin } from './observability.ts';
import { servicesPlugin } from './services.ts';
import { workspacesPlugin, type WorkspacesPluginOptions } from './workspaces.ts';
import { errors, CliCode } from '@syncengine/core';

// ── Virtual module ids ────────────────────────────────────────────────────

/** The import specifier consumers (e.g. `@syncengine/client`) use. */
const VIRTUAL_ID = 'virtual:syncengine/runtime-config';
/** Vite's convention: null-byte-prefix means "non-file module, don't touch". */
const RESOLVED_ID = '\0' + VIRTUAL_ID;

// ── Runtime config shape ──────────────────────────────────────────────────

/**
 * The values the client runtime needs to talk to the syncengine backend.
 * Populated from .syncengine/dev/runtime.json in dev or SYNCENGINE_* env
 * vars in production.
 */
export interface RuntimeConfig {
    workspaceId: string;
    natsUrl: string;
    gatewayUrl?: string;
    restateUrl: string;
    authToken: string | null;
}

// ── Plugin ────────────────────────────────────────────────────────────────

export interface SyncenginePluginOptions {
    /**
     * Override the location of the dev `runtime.json`. Defaults to
     * `<repoRoot>/.syncengine/dev/runtime.json`, where repoRoot is found
     * by walking up from the Vite config directory looking for
     * `pnpm-workspace.yaml`.
     */
    runtimeConfigPath?: string;
    /**
     * Options forwarded to the actors sub-plugin (`.actor.ts` discovery,
     * handler-body stripping, `/__syncengine/rpc` middleware).
     */
    actors?: ActorsPluginOptions;
    /**
     * Options forwarded to the workspaces sub-plugin (PLAN Phase 8:
     * `syncengine.config.ts` loading, `workspaces.resolve` invocation,
     * lazy provisioning, HTML meta-tag injection).
     */
    workspaces?: WorkspacesPluginOptions;
}

/**
 * Default export: returns an array of plugins so Vite can treat each
 * concern independently. This stays a single user-facing import:
 * `syncengine()` in vite.config.ts.
 */
export default function syncengine(opts: SyncenginePluginOptions = {}) {
    return [
        suppressServerWarningsPlugin(),
        wasmPlugin(),
        wasm(),
        topLevelAwait(),
        runtimeConfigPlugin(opts),
        schemaReloadPlugin(),
        actorsPlugin(opts.actors ?? {}),
        workspacesPlugin(opts.workspaces ?? {}),
        servicesPlugin(),
        devtoolsPlugin(),
        observabilityPlugin(),
    ];
}

// ── Schema-reload plugin ──────────────────────────────────────────────────
//
// The data worker (`@syncengine/client`'s SQLite-WASM sidecar) is booted
// once on page load with a snapshot of the schema baked into its INIT
// message. Adding or changing a `table(...)` in the user's source must
// therefore restart the worker — HMR alone just updates the React
// modules, leaves the worker's `tablesMeta` stale, and silently drops
// inserts to unknown tables with a `[worker] Unknown table: …` warning.
//
// This plugin watches for edits to schema-defining files and escalates
// them from HMR to a full page reload so the worker reboots and sees
// the new shape.
function schemaReloadPlugin(): Plugin {
    return {
        name: 'syncengine:schema-reload',

        async handleHotUpdate({ file, server, read }) {
            if (file.includes('node_modules')) return;
            if (!/\.(ts|tsx)$/.test(file)) return;
            // Entities, workflows, and topics have their own lifecycle —
            // they don't contribute to the worker's table schema.
            if (/\.(actor|workflow|topic)\.(ts|tsx)$/.test(file)) return;

            // Path convention first (cheap).
            const base = basename(file);
            const dir = dirname(file);
            const isSchemaByPath =
                base === 'schema.ts' ||
                base === 'schema.tsx' ||
                dir.endsWith('/schema') ||
                dir.endsWith('/schemas') ||
                dir.includes('/schema/') ||
                dir.includes('/schemas/');

            // Content fallback: any file that imports `table` from
            // @syncengine/core and actually calls it defines part of the
            // schema surface, wherever it lives on disk.
            let isSchemaByContent = false;
            if (!isSchemaByPath) {
                try {
                    const source = await read();
                    isSchemaByContent =
                        /from\s+['"]@syncengine\/core['"]/.test(source) &&
                        /\btable\s*\(/.test(source);
                } catch {
                    return;
                }
            }

            if (!isSchemaByPath && !isSchemaByContent) return;

            server.config.logger.info(
                `[syncengine] schema change in ${base} — full page reload (worker must reboot)`,
                { timestamp: true },
            );
            server.ws.send({ type: 'full-reload' });
            return [];
        },
    };
}

/**
 * Suppress noisy warnings from server-side deps that Vite's import
 * analysis walks but never includes in the client bundle. The vite
 * plugin imports @syncengine/server (for actor discovery) and the
 * devtools plugin imports @nats-io/transport-node — both are
 * server-only but Vite warns about every `node:*` module it finds.
 */
function suppressServerWarningsPlugin(): Plugin {
    return {
        name: 'syncengine:suppress-server-warnings',
        config() {
            return {
                build: {
                    rollupOptions: {
                        onwarn(warning, defaultHandler) {
                            // Suppress "Module X has been externalized for browser compatibility"
                            if (warning.message?.includes('has been externalized for browser compatibility')) return;
                            defaultHandler(warning);
                        },
                    },
                },
            };
        },
    };
}

/**
 * Injects worker config so WASM + top-level-await work in Web Workers
 * without the consumer having to configure `worker.plugins` manually.
 */
function wasmPlugin(): Plugin {
    return {
        name: 'syncengine:wasm',
        config() {
            return {
                worker: {
                    format: 'es' as const,
                    plugins: () => [wasm(), topLevelAwait()],
                },
            };
        },
    };
}

function runtimeConfigPlugin(opts: SyncenginePluginOptions): Plugin {
    let server: ViteDevServer | null = null;
    let runtimeConfigPath: string | null = null;
    let viteRoot: string | null = null;

    return {
        name: 'syncengine',

        configResolved(config) {
            viteRoot = config.root;
        },

        // Record the dev server reference so runtime.json changes can
        // invalidate the virtual module.
        configureServer(s) {
            server = s;

            // Resolve and watch the runtime config file.
            runtimeConfigPath = resolveRuntimeConfigPath(opts.runtimeConfigPath, viteRoot ?? s.config.root);
            s.watcher.add(runtimeConfigPath);
            s.watcher.on('change', (file) => {
                if (file !== runtimeConfigPath) return;
                // Invalidate the virtual module so next import re-reads
                // the runtime config. Vite will HMR any module that imports it.
                const mod = s.moduleGraph.getModuleById(RESOLVED_ID);
                if (mod) s.moduleGraph.invalidateModule(mod);
                s.ws.send({ type: 'full-reload' });
            });
            s.watcher.on('add', (file) => {
                if (file !== runtimeConfigPath) return;
                // When the CLI comes up AFTER the Vite dev server, runtime.json
                // appears; trigger the same HMR path.
                const mod = s.moduleGraph.getModuleById(RESOLVED_ID);
                if (mod) s.moduleGraph.invalidateModule(mod);
                s.ws.send({ type: 'full-reload' });
            });
        },

        // Reserve the virtual id so Vite doesn't try to resolve it on disk.
        resolveId(id) {
            if (id === VIRTUAL_ID) return RESOLVED_ID;
            return null;
        },

        // Emit the runtime config as an ES module every time the virtual
        // module is requested. In dev Vite will re-call this after our
        // `configureServer` invalidates the module.
        load(id) {
            if (id !== RESOLVED_ID) return null;
            const configPath = runtimeConfigPath ?? resolveRuntimeConfigPath(opts.runtimeConfigPath, viteRoot ?? undefined);
            const config = loadRuntimeConfig(configPath, server !== null);
            return renderRuntimeConfigModule(config);
        },
    };
}

// ── Path resolution ───────────────────────────────────────────────────────

/**
 * Resolve the path to `.syncengine/dev/runtime.json`.
 *
 * Priority:
 *   1. Explicit override from plugin options
 *   2. SYNCENGINE_STATE_DIR env var
 *   3. `<appRoot>/.syncengine/dev/runtime.json` — appRoot is either the
 *      Vite root (when available) or CWD. This keeps state per-app so
 *      monorepo users and standalone users both get the right behaviour.
 */
function resolveRuntimeConfigPath(override: string | undefined, appRoot?: string): string {
    if (override) return resolve(override);

    const envOverride = process.env.SYNCENGINE_STATE_DIR;
    if (envOverride) return join(resolve(envOverride), 'runtime.json');

    return join(appRoot ?? process.cwd(), '.syncengine', 'dev', 'runtime.json');
}

// ── Config loading ────────────────────────────────────────────────────────

function loadRuntimeConfig(path: string, isDev: boolean): RuntimeConfig {
    // Dev: runtime.json is the source of truth. If it's missing the CLI
    // isn't running yet — return a config that points at the defaults so
    // the client can still try to connect (and show a clear disconnect
    // state if no one's listening).
    if (isDev) {
        if (existsSync(path)) {
            try {
                const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeConfig>;
                return normalizeConfig(parsed);
            } catch (err) {
                console.warn(`[syncengine] failed to parse ${path}: ${(err as Error).message}`);
            }
        }
        return defaultDevConfig();
    }

    // Production: env vars provide the NATS / Restate URLs. The
    // workspace id is NOT baked in — as of PLAN Phase 8 workspaces are
    // resolved per request, so the production deployment (Phase 9)
    // injects the same `<meta name="syncengine-*">` tags at serve time
    // from an edge function. The compile-time fallback below is only
    // consumed when `document` is undefined (SSR, prerender) and
    // mirrors the dev default.
    //
    // Missing URL vars throw so deployments fail loudly instead of
    // silently pointing at localhost.
    const natsUrl = process.env.SYNCENGINE_NATS_URL;
    const restateUrl = process.env.SYNCENGINE_RESTATE_URL;
    if (!natsUrl || !restateUrl) {
        throw errors.cli(CliCode.ENV_MISSING, {
            message: `[syncengine] production build requires SYNCENGINE_NATS_URL and SYNCENGINE_RESTATE_URL environment variables.`,
            hint: `Set these in your deployment environment.`,
        });
    }
    return {
        workspaceId: process.env.SYNCENGINE_WORKSPACE_ID ?? 'default',
        natsUrl,
        restateUrl,
        authToken: process.env.SYNCENGINE_AUTH_TOKEN ?? null,
    };
}

function defaultDevConfig(): RuntimeConfig {
    // As of PLAN Phase 8 the browser path resolves workspaceId per
    // request via `<meta name="syncengine-workspace-id">`. This
    // fallback is only consumed when `document` is undefined
    // (SSR, vitest, node scripts) and mirrors the default resolver
    // in the workspaces sub-plugin, which returns the literal
    // 'default' for apps without a syncengine.config.ts.
    return {
        workspaceId: 'default',
        natsUrl: 'ws://localhost:9222',
        restateUrl: 'http://localhost:8080',
        authToken: null,
    };
}

function normalizeConfig(raw: Partial<RuntimeConfig>): RuntimeConfig {
    const fallback = defaultDevConfig();
    return {
        workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : fallback.workspaceId,
        natsUrl: typeof raw.natsUrl === 'string' ? raw.natsUrl : fallback.natsUrl,
        gatewayUrl: typeof raw.gatewayUrl === 'string' ? raw.gatewayUrl : fallback.gatewayUrl,
        restateUrl: typeof raw.restateUrl === 'string' ? raw.restateUrl : fallback.restateUrl,
        authToken: typeof raw.authToken === 'string' ? raw.authToken : null,
    };
}

// ── Module rendering ──────────────────────────────────────────────────────

/**
 * Emit the runtime-config virtual module.
 *
 * In dev (PLAN Phase 8), the workspace id is no longer a static value —
 * it's resolved per-request by the workspaces plugin and injected into
 * the served HTML via `<meta name="syncengine-*">` tags. This module
 * reads those meta tags at load time in the browser so a single bundle
 * can serve any number of users without a rebuild. The NATS and Restate
 * URLs follow the same pattern, giving the CLI the freedom to pick
 * different ports per dev run.
 *
 * In any non-browser context (SSR, vitest, node scripts), `document`
 * is undefined and the module falls back to the compile-time values
 * read from `runtime.json` / env vars — the same semantics as before
 * Phase 8, so the existing test stub at
 * `packages/client/src/__tests__/runtime-config.stub.ts` keeps working.
 */
function renderRuntimeConfigModule(config: RuntimeConfig): string {
    // JSON.stringify escapes for us — safe for both strings and null.
    const fallbackWorkspaceId = JSON.stringify(config.workspaceId);
    const fallbackNatsUrl = JSON.stringify(config.natsUrl);
    const fallbackGatewayUrl = JSON.stringify(config.gatewayUrl ?? '');
    const fallbackRestateUrl = JSON.stringify(config.restateUrl);
    const fallbackAuthToken = JSON.stringify(config.authToken);

    return [
        `// Generated by @syncengine/vite-plugin — do not edit`,
        ``,
        `function readMeta(name, fallback) {`,
        `    if (typeof document === 'undefined') return fallback;`,
        `    const el = document.querySelector('meta[name="syncengine-' + name + '"]');`,
        `    const value = el && el.getAttribute('content');`,
        `    return value != null && value !== '' ? value : fallback;`,
        `}`,
        ``,
        `export const workspaceId = readMeta('workspace-id', ${fallbackWorkspaceId});`,
        `export const natsUrl = readMeta('nats-url', ${fallbackNatsUrl});`,
        `export const gatewayUrl = readMeta('gateway-url', ${fallbackGatewayUrl});`,
        `export const restateUrl = readMeta('restate-url', ${fallbackRestateUrl});`,
        `const _authTokenMeta = readMeta('auth-token', '');`,
        `export const authToken = _authTokenMeta || ${fallbackAuthToken};`,
        ``,
    ].join('\n');
}
