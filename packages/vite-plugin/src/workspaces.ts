/**
 * `@syncengine/vite-plugin` — workspaces sub-plugin (PLAN Phase 8).
 *
 * Responsibilities:
 *
 *   1. Load the user's `syncengine.config.ts` from the Vite project root
 *      once at startup. The config's `workspaces.resolve({ request, user })`
 *      is called on every page request to turn a raw user identity into
 *      a stable workspace id.
 *
 *   2. Hash the resolved id to a bounded-length `wsKey` (SHA-256 first
 *      `WSKEY_HEX_CHARS` hex chars). NATS subject tokens and Restate
 *      virtual-object keys have length limits, and users might return
 *      `org:long-orgname` or URL-derived strings — hashing keeps the
 *      internal names sane.
 *
 *   3. Lazy-provision each wsKey the first time it's seen by POSTing to
 *      the framework's existing `workspace.provision` Restate handler.
 *      Provisioned keys are cached in memory for the dev session; a
 *      fresh orchestrator run re-provisions on first request. Concurrent
 *      first-requests share a single inflight provision via a map so
 *      we never double-POST.
 *
 *   4. Run resolution from a Connect middleware that sees the real
 *      IncomingMessage (headers, cookies, auth), not a fake built from
 *      `ctx.originalUrl`. The resolved values are passed through to
 *      Vite's `transformIndexHtml` hook via AsyncLocalStorage so we
 *      can still use Vite's official HTML-injection path.
 *
 * The `user` parameter passed to `resolve` is a stub in dev: the
 * middleware builds `{ id: <query-param> }` from the incoming URL's
 * `?user=` search param. Real auth (Clerk / Auth.js / custom) plugs in
 * at the same seam in a future phase by replacing the stub with the
 * session user. The resolve contract doesn't change.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Connect, Plugin, ViteDevServer } from 'vite';

import {
    hashWorkspaceId,
    injectMetaTags,
    escapeAttr,
    provisionWorkspace,
} from '@syncengine/core/http';

// Structural types mirroring `@syncengine/core`'s `config.ts`. The
// plugin intentionally does not take a dep on core to keep the
// package boundary clean — core can consume the plugin, not the other
// way around.
//
// ⚠️  DRIFT RISK: these types are load-bearing for the resolve-callback
// contract, so any change to the equivalent interfaces in
// `packages/core/src/config.ts` MUST be mirrored here. There is no
// compile-time check enforcing this — a mismatch surfaces only at
// runtime inside user-provided resolvers. If core adds a required
// field to SyncengineUser or WorkspaceResolveContext, update this
// file in the same commit.

interface SyncengineUser {
    readonly id: string;
    readonly [key: string]: unknown;
}

interface WorkspaceResolveContext {
    readonly request: Request;
    readonly user: SyncengineUser;
}

interface WorkspacesConfig {
    readonly resolve: (
        ctx: WorkspaceResolveContext,
    ) => string | Promise<string>;
}

interface SyncengineConfig {
    readonly workspaces: WorkspacesConfig;
}

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
async function loadConfig(
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
                throw new Error(`${path} has no default export`);
            }
            return mod.default;
        } catch (err) {
            // Preserve the underlying stack trace so the developer can
            // see the actual line in their config file that failed.
            throw new Error(`[syncengine] failed to load ${path}`, { cause: err });
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
 * Build the `user` stub the plugin passes into `workspaces.resolve`.
 * In dev we read a `?user=` query param from the request URL. Real
 * auth plugs in here in a later phase (Clerk session, Auth.js, etc.).
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
    const provisioned = new Set<string>();
    const provisioning = new Map<string, Promise<void>>();
    const readDevRuntime = makeRuntimeCache();

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

    /**
     * Ensure the wsKey is provisioned. Concurrent first-requests for
     * the same key share a single inflight promise so we never fire
     * two `workspace.provision` POSTs for the same key.
     */
    const ensureProvisioned = async (wsKey: string, restateUrl: string): Promise<void> => {
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

                let config: SyncengineConfig;
                try {
                    config = await getConfig();
                } catch (err) {
                    // Config load failed; render a dev-mode error page
                    // so the developer immediately knows something is
                    // broken. configPromise has already been cleared
                    // by getConfig's catch handler, so fixing the file
                    // and reloading will retry cleanly.
                    return sendDevError(res, 'failed to load syncengine.config.ts', err);
                }

                const user = extractUser(req);
                const request = buildRequest(req);

                let rawWorkspaceId: string;
                try {
                    rawWorkspaceId = await config.workspaces.resolve({ request, user });
                } catch (err) {
                    // Never fall through to a stable 'error' workspace —
                    // that would silently merge every failing user's
                    // data into one shared backend. Stop the request.
                    return sendDevError(res, `workspaces.resolve failed for user=${user.id}`, err);
                }

                if (typeof rawWorkspaceId !== 'string' || rawWorkspaceId.length === 0) {
                    return sendDevError(
                        res,
                        'workspaces.resolve must return a non-empty string',
                        new Error(`got ${typeof rawWorkspaceId}: ${String(rawWorkspaceId)}`),
                    );
                }

                const wsKey = hashWorkspaceId(rawWorkspaceId);

                // Pick up the NATS WS / Restate URLs from the cached
                // dev runtime file written by the CLI orchestrator;
                // fall back to the hard defaults if the CLI isn't
                // running yet (file missing or unparseable).
                const runtime = readDevRuntime(viteRoot ?? server.config.root);
                const natsUrl = runtime.natsUrl ?? 'ws://localhost:9222';
                const gatewayUrl = runtime.gatewayUrl;
                const restateUrl = runtime.restateUrl ?? 'http://localhost:8080';
                const restateForProvision = opts.restateUrl ?? restateUrl;

                try {
                    await ensureProvisioned(wsKey, restateForProvision);
                } catch (err) {
                    // Provisioning failure is warn-and-continue: the
                    // user sees a broken app (the client will retry
                    // connecting) but the dev server itself stays up
                    // so fixing Restate doesn't require a Vite restart.
                    const msg = err instanceof Error ? err.message : String(err);
                    // eslint-disable-next-line no-console
                    console.warn(
                        `[syncengine] provision(${wsKey}) for user=${user.id} failed: ${msg}`,
                    );
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
         */
        transformIndexHtml(html) {
            const ctx = als.getStore();
            if (!ctx) return html;
            return injectMetaTags(html, {
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
