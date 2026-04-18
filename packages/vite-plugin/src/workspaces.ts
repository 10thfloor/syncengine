/**
 * `@syncengine/vite-plugin` — workspaces sub-plugin (PLAN Phase 8).
 *
 * Dev-mode wiring around the shared `@syncengine/http-core` pipeline:
 *
 *   1. Load the user's `syncengine.config.ts` from the Vite project root,
 *      lazily on first request and hot-reloaded on file edits.
 *
 *   2. On every HTML request, marshal the Connect `IncomingMessage` into
 *      a standard `Request` and delegate to `http-core.resolveWorkspace`.
 *      That function runs auth.verify + workspaces.resolve + hash +
 *      provision. The same function runs in the prod `syncengine serve`
 *      binary, so dev and prod resolve identically.
 *
 *   3. Thread the resolved context (wsKey, natsUrl, restateUrl, etc.)
 *      through AsyncLocalStorage into Vite's `transformIndexHtml` hook
 *      so meta tags land on Vite's official HTML-injection path.
 *
 * Dev-only conveniences:
 *
 *   - If the user hasn't declared `auth.verify` in their config,
 *     `devAuthShim` injects one that reads `?user=` from the URL.
 *     Preserves the pre-auth-hook "open two tabs with different users"
 *     demo flow without forcing apps to declare auth for local dev.
 *
 *   - Provisioning failures log a warning and let the page load anyway —
 *     restarting Restate shouldn't take the dev page down. Prod uses
 *     the same pipeline without the `onProvisionError` override, so
 *     real users see a proper 502 when provisioning fails.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Connect, Plugin, ViteDevServer } from 'vite';

import {
    escapeAttr,
    provisionWorkspace,
} from '@syncengine/core/http';
import { errors, SchemaCode } from '@syncengine/core';
import type { SyncengineConfig, SyncengineUser } from '@syncengine/core';
import {
    ProvisionCache,
    createHtmlInjector,
    resolveWorkspace,
} from '@syncengine/http-core';

// ── Defaults (used when no syncengine.config.ts is present) ────────────────

/**
 * Fallback resolver for apps that haven't written a syncengine.config.ts
 * yet. Returns a constant 'default' id so everything keeps working
 * (single-user dev mode) without forcing the user to add a config file
 * just to see the demo.
 */
const DEFAULT_CONFIG: SyncengineConfig = {
    workspaces: {
        resolve: () => 'default',
    },
};

// ── Options ─────────────────────────────────────────────────────────────────

export interface WorkspacesPluginOptions {
    /**
     * Override the config file location. Defaults to
     * `<viteRoot>/syncengine.config.ts`.
     */
    configPath?: string;
    /**
     * Override the base URL of the Restate ingress used for lazy
     * provisioning. Defaults to `http://localhost:8080` (dev) or the
     * value in `.syncengine/dev/runtime.json`.
     */
    restateUrl?: string;
}

// ── Config loading ──────────────────────────────────────────────────────────

/**
 * Resolve the list of candidate config paths for a given Vite root.
 * The first existing file wins; if none exist the caller falls back
 * to `DEFAULT_CONFIG`. Exposed separately from `loadConfig` so the
 * `configureServer` watcher can subscribe to the same set of paths.
 */
function candidateConfigPaths(
    viteRoot: string,
    opts: WorkspacesPluginOptions,
): string[] {
    return opts.configPath
        ? [resolvePath(opts.configPath)]
        : [
            resolvePath(viteRoot, 'syncengine.config.ts'),
            resolvePath(viteRoot, 'syncengine.config.js'),
            resolvePath(viteRoot, 'syncengine.config.mjs'),
        ];
}

/**
 * Load the syncengine.config.ts file via Vite's SSR loader, which
 * handles TypeScript transpilation on the fly without pulling in
 * ts-node / tsx as a dep.
 *
 * If the file doesn't exist, returns DEFAULT_CONFIG. If it exists but
 * throws on load, wraps the underlying error (preserving the stack via
 * `{ cause }`) so the developer sees the real failure, not a one-line
 * message.
 */
export async function loadConfig(
    viteRoot: string,
    server: ViteDevServer,
    opts: WorkspacesPluginOptions,
): Promise<SyncengineConfig> {
    for (const path of candidateConfigPaths(viteRoot, opts)) {
        if (!existsSync(path)) continue;
        try {
            const mod = (await server.ssrLoadModule(path)) as {
                default?: SyncengineConfig;
            };
            if (!mod.default) {
                throw errors.schema(SchemaCode.CONFIG_NO_DEFAULT_EXPORT, {
                    message: `${path} has no default export`,
                    hint: `Add: export default defineConfig({ ... })`,
                    context: { path },
                });
            }
            return mod.default;
        } catch (err) {
            // Preserve the underlying stack trace so the developer can
            // see the actual line in their config file that failed.
            throw errors.schema(SchemaCode.CONFIG_LOAD_FAILED, {
                message: `[syncengine] failed to load ${path}`,
                context: { path },
                cause: err instanceof Error ? err : new Error(String(err)),
            });
        }
    }
    return DEFAULT_CONFIG;
}

// ── Dev runtime config (mirrors actors.ts helper) ──────────────────────────

interface DevRuntimeJson {
    natsUrl?: string;
    gatewayUrl?: string;
    restateUrl?: string;
    authToken?: string | null;
}

/**
 * Read `.syncengine/dev/runtime.json` once and cache the result. The
 * CLI orchestrator writes this file exactly once per dev run, so a
 * sync fs read on every page render is wasted work. If the file
 * doesn't exist at first read (the CLI booted AFTER Vite), we cache
 * the empty object and fall through to the hardcoded defaults — the
 * next orchestrator start rewrites the file and triggers a watcher
 * elsewhere in the plugin that invalidates the virtual runtime module.
 */
function makeRuntimeCache(): (root: string) => DevRuntimeJson {
    let cached: { root: string; value: DevRuntimeJson } | null = null;
    return (root: string) => {
        if (cached && cached.root === root) return cached.value;
        const path = resolvePath(root, '.syncengine', 'dev', 'runtime.json');
        let value: DevRuntimeJson = {};
        if (existsSync(path)) {
            try {
                value = JSON.parse(readFileSync(path, 'utf8')) as DevRuntimeJson;
            } catch {
                // leave empty; falls through to hardcoded defaults
            }
        }
        cached = { root, value };
        return value;
    };
}

// ── User extraction from the incoming request ─────────────────────────────

/**
 * Build the `user` stub the plugin passes into `workspaces.resolve`
 * when the user's config has no `auth.verify` declared. Reads the
 * `?user=` query param from the request URL.
 *
 * Kept for backward compat with existing tests and as a small helper
 * for the devAuthShim below. Real prod auth uses `auth.verify` in the
 * user's config; `devAuthShim` short-circuits this function when that's
 * present.
 *
 * @internal Exported for unit tests.
 */
export function extractUser(req: Connect.IncomingMessage): SyncengineUser {
    const url = req.url ?? '/';
    const parsed = new URL(url, 'http://localhost');
    const queryUser = parsed.searchParams.get('user') ?? 'anon';
    return { id: queryUser };
}

/**
 * Dev-convenience shim: if the user hasn't declared `auth.verify` in
 * their syncengine.config.ts, inject a synthetic one that reads the
 * `?user=` query param. This preserves the pre-auth-hook dev workflow
 * (open two tabs with `?user=alice` and `?user=bob` to see real-time
 * sync between users) while letting `http-core.resolveWorkspace` own
 * the resolve pipeline in both dev and prod.
 *
 * When `auth.verify` IS declared, the user's callback wins — behavior
 * matches production exactly.
 *
 * @internal Exported for unit tests.
 */
export function devAuthShim(config: SyncengineConfig): SyncengineConfig {
    if (config.auth) return config;
    return {
        ...config,
        auth: {
            verify: ({ request }) => {
                const url = new URL(request.url);
                return { id: url.searchParams.get('user') ?? 'anon' };
            },
        },
    };
}

/**
 * Build a standard Request object from a Connect incoming message so
 * the user's `resolve` function can treat it like a Fetch Request.
 * The real headers, cookies, and auth tokens are copied across so
 * production-style resolvers (Clerk session cookies, Auth.js JWTs)
 * work unmodified. Body is not copied — workspace resolution happens
 * before the body is read.
 *
 * @internal Exported for unit tests.
 */
export function buildRequest(req: Connect.IncomingMessage): Request {
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

// ── Request-scoped context carried through AsyncLocalStorage ────────────

interface ResolvedWorkspace {
    wsKey: string;
    natsUrl: string;
    gatewayUrl?: string;
    restateUrl: string;
}

/**
 * Shared storage that passes the resolved workspace from the
 * middleware (which has access to the full IncomingMessage) through
 * to Vite's `transformIndexHtml` hook (which does not). Node's
 * async_hooks propagate values across awaits automatically, so as
 * long as the middleware wraps `next()` in `als.run(...)` the
 * hook's callback runs inside the same context.
 */
const als = new AsyncLocalStorage<ResolvedWorkspace>();

// ── Plugin factory ──────────────────────────────────────────────────────────

export function workspacesPlugin(opts: WorkspacesPluginOptions = {}): Plugin {
    let viteRoot: string | null = null;
    let devServer: ViteDevServer | null = null;
    let configPromise: Promise<SyncengineConfig> | null = null;
    const readDevRuntime = makeRuntimeCache();

    // The provision cache is built lazily on first request so the
    // restateUrl (read from the dev runtime.json, which may not exist
    // at plugin-construction time) is available. Cache lifetime ==
    // Vite process lifetime; identity is stable across requests.
    let provisionCache: ProvisionCache | null = null;
    const getProvisionCache = (restateUrl: string): ProvisionCache => {
        if (!provisionCache) {
            provisionCache = new ProvisionCache((wsKey) =>
                provisionWorkspace(restateUrl, wsKey),
            );
        }
        return provisionCache;
    };

    /**
     * Lazy-load the config. On failure, clears the cached promise so
     * the next request retries — otherwise a syntax error in
     * `syncengine.config.ts` would poison the dev session until Vite
     * is killed and restarted, which is hostile DX.
     */
    const getConfig = async (): Promise<SyncengineConfig> => {
        if (!configPromise) {
            if (!viteRoot || !devServer) return DEFAULT_CONFIG;
            configPromise = loadConfig(viteRoot, devServer, opts).catch((err) => {
                configPromise = null;
                throw err;
            });
        }
        return configPromise;
    };

    return {
        name: 'syncengine:workspaces',

        configResolved(config) {
            viteRoot = config.root;
        },

        configureServer(server) {
            devServer = server;

            // Watch the candidate config paths so edits to
            // `syncengine.config.ts` take effect without a Vite
            // restart. On any change/add/unlink we drop the cached
            // `configPromise` and also invalidate the Vite SSR
            // module for that file so the next `ssrLoadModule` call
            // re-evaluates the source rather than returning the
            // already-transpiled copy from Vite's own cache.
            if (viteRoot) {
                const configPaths = candidateConfigPaths(viteRoot, opts);
                for (const path of configPaths) {
                    server.watcher.add(path);
                }
                const onConfigChange = (changed: string): void => {
                    if (!configPaths.includes(changed)) return;
                    configPromise = null;
                    const mod = server.moduleGraph.getModuleById(changed);
                    if (mod) server.moduleGraph.invalidateModule(mod);
                    // Full reload so any tab that's currently open
                    // re-fetches the HTML and the new resolver runs.
                    server.ws.send({ type: 'full-reload' });
                    // eslint-disable-next-line no-console
                    console.log('[syncengine] syncengine.config.ts changed, reloaded');
                };
                server.watcher.on('change', onConfigChange);
                server.watcher.on('add', onConfigChange);
                server.watcher.on('unlink', onConfigChange);
            }

            // Install BEFORE Vite's built-in HTML handler so we can
            // resolve the workspace from the real IncomingMessage and
            // seed the AsyncLocalStorage context that transformIndexHtml
            // reads from.
            server.middlewares.use(async (req, res, next) => {
                // Only intercept HTML-looking GET requests. Vite serves
                // a LOT of things (modules, sourcemaps, HMR websockets)
                // and most of them have nothing to do with workspace
                // resolution.
                if (req.method && req.method !== 'GET') return next();
                const url = req.url ?? '';
                if (url.startsWith('/@') || url.startsWith('/__')) return next();
                const accept = req.headers.accept ?? '';
                // Match browser HTML requests: either the Accept header
                // contains text/html, or the URL has no extension and
                // is eligible for index.html resolution.
                const isHtml = accept.includes('text/html')
                    || (!/\.[a-zA-Z0-9]+(\?|$)/.test(url));
                if (!isHtml) return next();

                let rawConfig: SyncengineConfig;
                try {
                    rawConfig = await getConfig();
                } catch (err) {
                    // Config load failed; render a dev-mode error page
                    // so the developer immediately knows something is
                    // broken. configPromise has already been cleared
                    // by getConfig's catch handler, so fixing the file
                    // and reloading will retry cleanly.
                    return sendDevError(res, 'failed to load syncengine.config.ts', err);
                }

                // Pick up the NATS WS / Restate URLs from the cached
                // dev runtime file written by the CLI orchestrator;
                // fall back to the hard defaults if the CLI isn't
                // running yet (file missing or unparseable).
                const runtime = readDevRuntime(viteRoot ?? server.config.root);
                const natsUrl = runtime.natsUrl ?? 'ws://localhost:9222';
                const gatewayUrl = runtime.gatewayUrl;
                const restateUrl = runtime.restateUrl ?? 'http://localhost:8080';
                const restateForProvision = opts.restateUrl ?? restateUrl;

                // Delegate the whole pipeline — auth.verify, resolve,
                // hash, provision — to @syncengine/http-core, which is
                // also what the prod serve binary uses. `devAuthShim`
                // preserves the pre-existing `?user=` dev shortcut when
                // the user hasn't declared their own `auth.verify`.
                const config = devAuthShim(rawConfig);
                const request = buildRequest(req);

                let wsKey: string;
                try {
                    const result = await resolveWorkspace(request, {
                        config,
                        provisionCache: getProvisionCache(restateForProvision),
                        // Dev is warn-and-continue on provision failures
                        // — restarting Restate shouldn't kill the page.
                        // Prod (syncengine serve) omits this and lets
                        // the error surface as a 502.
                        onProvisionError: (err, key) => {
                            const msg = err instanceof Error ? err.message : String(err);
                            // eslint-disable-next-line no-console
                            console.warn(`[syncengine] provision(${key}) failed: ${msg}`);
                        },
                    });
                    wsKey = result.wsKey;
                } catch (err) {
                    // Resolve failures (RESOLVE_FAILED / RESOLVE_TIMEOUT)
                    // get the dev-mode error page. Never fall through
                    // to a default workspace — that would silently merge
                    // every failing user's data into one shared backend.
                    return sendDevError(res, 'workspace resolution failed', err);
                }

                // Run the remainder of the middleware chain (including
                // Vite's HTML renderer, which calls transformIndexHtml)
                // inside our async context so the hook can read the
                // resolved values without a second call to resolve().
                const ctx: ResolvedWorkspace = { wsKey, natsUrl, gatewayUrl, restateUrl };
                als.run(ctx, () => next());
            });
        },

        /**
         * Inject the meta tags using values resolved by the middleware
         * above. Because Vite calls us from within the middleware's
         * `next()` chain, AsyncLocalStorage has already been seeded
         * with the request context.
         *
         * If the hook fires outside our middleware path (non-browser
         * requests, tooling that asks Vite for the raw index html),
         * the store is undefined and we return the HTML unchanged.
         *
         * Vite may hand us different HTML bodies per request (templates
         * with user-land HTML transformations, etc.), so we construct
         * the injector per call. For prod, the serve binary caches a
         * single injector once at boot because index.html is static.
         */
        transformIndexHtml(html) {
            const ctx = als.getStore();
            if (!ctx) return html;
            return createHtmlInjector(html).inject({
                workspaceId: ctx.wsKey,
                natsUrl: ctx.natsUrl,
                restateUrl: ctx.restateUrl,
                gatewayUrl: ctx.gatewayUrl,
            });
        },
    };
}

// ── Dev error response ─────────────────────────────────────────────────────

/**
 * Render a dev-mode error page showing the underlying failure. Used
 * when the config can't be loaded or the user's resolve() throws —
 * both are developer bugs that deserve a loud visible failure rather
 * than a silent fall-through to a default workspace.
 */
function sendDevError(
    res: Parameters<Connect.NextHandleFunction>[1],
    headline: string,
    cause: unknown,
): void {
    const msg = formatErrorChain(cause);
    const body = `<!doctype html>
<html><head><title>[syncengine] ${escapeAttr(headline)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; margin: 2rem; color: #e5e5e5; background: #0a0a0a; }
  h1 { color: #ef4444; font-size: 1.1rem; }
  pre { background: #171717; color: #fca5a5; padding: 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
  .hint { color: #a3a3a3; margin-top: 1rem; font-size: 0.9rem; }
</style>
</head><body>
<h1>[syncengine] ${escapeAttr(headline)}</h1>
<pre>${escapeAttr(msg)}</pre>
<p class="hint">Fix the issue and reload — the dev server will retry on the next request.</p>
</body></html>`;
    res.statusCode = 500;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
}

/**
 * Walk an Error's `cause` chain and concatenate the stack traces so
 * the dev error page shows the original failure (e.g., the esbuild
 * parse error) underneath the wrapping `[syncengine] failed to load`
 * frame. Without this, only the outer frame is visible and the
 * developer has to dig through Vite's terminal logs to find the
 * actual line that's broken.
 */
function formatErrorChain(err: unknown): string {
    const parts: string[] = [];
    let current: unknown = err;
    let depth = 0;
    while (current && depth < 10) {
        if (current instanceof Error) {
            parts.push(current.stack ?? current.message);
            current = (current as Error & { cause?: unknown }).cause;
            if (current) parts.push('Caused by:');
        } else {
            parts.push(String(current));
            current = null;
        }
        depth += 1;
    }
    return parts.join('\n');
}
