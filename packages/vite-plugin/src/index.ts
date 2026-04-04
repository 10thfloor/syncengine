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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Plugin, ViteDevServer } from 'vite';

import { actorsPlugin, type ActorsPluginOptions } from './actors.ts';

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
     * `server({...})` stripping, `/__syncengine/rpc` middleware).
     */
    actors?: ActorsPluginOptions;
}

/**
 * Default export: returns an array of plugins so Vite can treat each
 * concern independently (runtime-config virtual module + actors
 * discovery/stripping/middleware). This stays a single user-facing
 * import: `syncengine()` in vite.config.ts.
 */
export default function syncengine(opts: SyncenginePluginOptions = {}): Plugin[] {
    return [runtimeConfigPlugin(opts), actorsPlugin(opts.actors ?? {})];
}

function runtimeConfigPlugin(opts: SyncenginePluginOptions): Plugin {
    let server: ViteDevServer | null = null;
    let runtimeConfigPath: string | null = null;

    return {
        name: 'syncengine',

        // Record the dev server reference so runtime.json changes can
        // invalidate the virtual module.
        configureServer(s) {
            server = s;

            // Resolve and watch the runtime config file.
            runtimeConfigPath = resolveRuntimeConfigPath(opts.runtimeConfigPath);
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
            const configPath = runtimeConfigPath ?? resolveRuntimeConfigPath(opts.runtimeConfigPath);
            const config = loadRuntimeConfig(configPath, server !== null);
            return renderRuntimeConfigModule(config);
        },
    };
}

// ── Path resolution ───────────────────────────────────────────────────────

/**
 * Walk up from the current working directory looking for the repo root
 * marker (`pnpm-workspace.yaml`). Fallback: compute relative to this
 * source file if the walk doesn't find anything (e.g. when the plugin
 * is called from a standalone Vite project without a workspace).
 */
function resolveRuntimeConfigPath(override: string | undefined): string {
    if (override) return resolve(override);

    const envOverride = process.env.SYNCENGINE_STATE_DIR;
    if (envOverride) return join(resolve(envOverride), 'runtime.json');

    // Walk up from CWD.
    let dir = process.cwd();
    while (true) {
        if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
            return join(dir, '.syncengine', 'dev', 'runtime.json');
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    // Fallback: next to this file (useful if the plugin is installed as a
    // dep in a repo without the workspace marker).
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..', '..', '..', '.syncengine', 'dev', 'runtime.json');
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

    // Production: env vars are the source of truth. Missing vars throw
    // at module load time so deployments fail loudly instead of silently
    // pointing at localhost.
    const workspaceId = process.env.SYNCENGINE_WORKSPACE_ID;
    const natsUrl = process.env.SYNCENGINE_NATS_URL;
    const restateUrl = process.env.SYNCENGINE_RESTATE_URL;
    if (!workspaceId || !natsUrl || !restateUrl) {
        throw new Error(
            `[syncengine] production build requires SYNCENGINE_WORKSPACE_ID, ` +
            `SYNCENGINE_NATS_URL, and SYNCENGINE_RESTATE_URL to be set.`,
        );
    }
    return {
        workspaceId,
        natsUrl,
        restateUrl,
        authToken: process.env.SYNCENGINE_AUTH_TOKEN ?? null,
    };
}

function defaultDevConfig(): RuntimeConfig {
    return {
        workspaceId: 'demo',
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
        restateUrl: typeof raw.restateUrl === 'string' ? raw.restateUrl : fallback.restateUrl,
        authToken: typeof raw.authToken === 'string' ? raw.authToken : null,
    };
}

// ── Module rendering ──────────────────────────────────────────────────────

function renderRuntimeConfigModule(config: RuntimeConfig): string {
    // JSON.stringify escapes for us — safe for both strings and null.
    return (
        `// Generated by @syncengine/vite-plugin — do not edit\n` +
        `export const workspaceId = ${JSON.stringify(config.workspaceId)};\n` +
        `export const natsUrl = ${JSON.stringify(config.natsUrl)};\n` +
        `export const restateUrl = ${JSON.stringify(config.restateUrl)};\n` +
        `export const authToken = ${JSON.stringify(config.authToken)};\n`
    );
}
