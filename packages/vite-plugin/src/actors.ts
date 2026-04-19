/**
 * `@syncengine/vite-plugin` — actors sub-plugin (PLAN.md Phase 4).
 *
 * Responsibilities:
 *
 *   1. Discover `.actor.ts` files via a walk of the user's `src/` tree
 *      during `buildStart`, and build an in-memory registry keyed by
 *      absolute path.
 *   2. Intercept client-side imports of those files: the `transform`
 *      hook finds every `server({...})` call and replaces the braced
 *      argument with a stub object literal that maps each handler name
 *      to a throwing function, so the handler bodies never land in
 *      the client bundle.
 *   3. Add a dev middleware at `/__syncengine/rpc/<entity>/<key>/<handler>`
 *      that forwards POST bodies to the framework's Restate entity
 *      runtime. The browser never needs to know the Restate URL, and
 *      RPC requests stay on the dev-server origin.
 *
 * NOTE: the framework's own server (`@syncengine/server`, run under tsx
 * outside of Vite) loads `.actor.ts` files via its own glob — it never
 * sees the stubbed version. So the stripping is client-bundle-only by
 * construction; we don't need a Vite Environment declaration to isolate
 * the two graphs.
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';

import { hashWorkspaceId } from '@syncengine/core/http';
import {
    resolveWorkspaceId,
    resolveWorkflowTarget,
    resolveHeartbeatTarget,
    resolveEntityTarget,
    isRpcError,
} from '@syncengine/http-core';
import { instrument } from '@syncengine/observe';

// ── Registry ────────────────────────────────────────────────────────────────

/** What we know about a single `.actor.ts` file after discovery. */
export interface ActorInfo {
    /** Absolute path to the source file. */
    readonly absPath: string;
    /** Path relative to the app root, for log messages. */
    readonly relPath: string;
}

export interface ActorRegistry {
    readonly byPath: Map<string, ActorInfo>;
    /** Quick membership check for transform-hook targeting. */
    readonly paths: Set<string>;
}

function emptyRegistry(): ActorRegistry {
    return { byPath: new Map(), paths: new Set() };
}

// ── Plugin options ──────────────────────────────────────────────────────────

export interface ActorsPluginOptions {
    /**
     * Override the user-app source directory that will be scanned for
     * `.actor.ts` files. Defaults to `<viteRoot>/src`.
     */
    srcDir?: string;
    /**
     * Override the base URL that the dev middleware forwards to when
     * handling `/__syncengine/rpc/*` POSTs. Defaults to reading
     * `.syncengine/dev/runtime.json` at dev start (same file the
     * runtime-config plugin reads for the browser side).
     */
    restateUrl?: string;
}

// ── File discovery ──────────────────────────────────────────────────────────

/**
 * Walk a directory tree and collect every `.actor.ts` file below it.
 * Intentionally uses `readdirSync` + a small queue instead of a glob
 * library to keep the plugin dependency-free. Skips `node_modules`,
 * `.git`, and `dist` to avoid pulling in unrelated files.
 */
function discoverActorFiles(srcDir: string): string[] {
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
            } else if (
                st.isFile() && (
                    name.endsWith('.actor.ts') ||
                    name.endsWith('.workflow.ts') ||
                    name.endsWith('.heartbeat.ts') ||
                    name.endsWith('.webhook.ts') ||
                    name.endsWith('.bus.ts')
                )
            ) {
                out.push(full);
            }
        }
    }
    return out;
}

// ── Transform: strip handler bodies on the client ──────────────────────────

/**
 * Given the source of a `.actor.ts` file, return the same source with
 * every `handlers:` property inside a `defineEntity(...)` call's second
 * argument replaced by a stub object literal that maps each handler
 * name to a throw function. The file extension itself is the transform
 * boundary — only files the plugin discovered via its src-walk get
 * passed to this function.
 *
 * This is intentionally a small hand-rolled scanner rather than a full
 * parser. The pattern we're looking for is:
 *
 *     defineEntity('name', {
 *         state: { ... },
 *         handlers: { foo(state, ...) { ... }, bar: async (s) => {...} },
 *     })
 *
 * We scan forward for `defineEntity(`, skip to its object-literal
 * argument (the second positional arg), locate the top-level
 * `handlers:` key inside that literal, and replace the value with a
 * stub preserving the handler names. The approach handles:
 *
 *   - shorthand methods:                foo(state, x) { ... }
 *   - async shorthand methods:          async foo(state, x) { ... }
 *   - arrow assignments:                foo: (state, x) => { ... }
 *   - function expressions:             foo: function(s) { ... }
 *   - optional `server()` wrapping:     handlers: server({ ... })
 *
 * If the handlers value can't be parsed as an object literal (e.g., the
 * user assigned an external variable), the call is passed through
 * unchanged — the runtime stub won't apply, but the file still
 * compiles. Recommended form is always a literal.
 */
export function stripServerCalls(source: string): string {
    // Handler bodies are pure functions — they run on both client and
    // server. Keeping the originals enables true latency compensation:
    // the client runs the handler locally for an instant optimistic
    // update, then POSTs to Restate for the authoritative result.
    return source;
}


/**
 * Find the index of the character that closes the bracket at `openIdx`
 * in `src`, respecting nested brackets and skipping over string literals
 * and comments. Returns -1 if no balanced close is found.
 */
function findBalancedClose(
    src: string,
    openIdx: number,
    open: string,
    close: string,
): number {
    let depth = 0;
    let i = openIdx;
    while (i < src.length) {
        const c = src[i]!;
        // Line comments
        if (c === '/' && src[i + 1] === '/') {
            const nl = src.indexOf('\n', i);
            if (nl === -1) return -1;
            i = nl + 1;
            continue;
        }
        // Block comments
        if (c === '/' && src[i + 1] === '*') {
            const endBlock = src.indexOf('*/', i + 2);
            if (endBlock === -1) return -1;
            i = endBlock + 2;
            continue;
        }
        // String literals
        if (c === '"' || c === "'" || c === '`') {
            i = skipString(src, i, c);
            if (i === -1) return -1;
            continue;
        }
        if (c === open) {
            depth++;
            i++;
            continue;
        }
        if (c === close) {
            depth--;
            if (depth === 0) return i;
            i++;
            continue;
        }
        // Other opening brackets — skip through them so we don't
        // miscount if the same bracket family appears nested.
        if (c === '(' || c === '{' || c === '[') {
            const pairClose = c === '{' ? '}' : c === '(' ? ')' : ']';
            const end = findBalancedClose(src, i, c, pairClose);
            if (end === -1) return -1;
            i = end + 1;
            continue;
        }
        i++;
    }
    return -1;
}

function skipString(src: string, startIdx: number, quote: string): number {
    let i = startIdx + 1;
    while (i < src.length) {
        const c = src[i]!;
        if (c === '\\') { i += 2; continue; }
        if (quote === '`' && c === '$' && src[i + 1] === '{') {
            const endBrace = findBalancedClose(src, i + 1, '{', '}');
            if (endBrace === -1) return -1;
            i = endBrace + 1;
            continue;
        }
        if (c === quote) return i + 1;
        i++;
    }
    return -1;
}


// ── Workflow stub ──────────────────────────────────────────────────────────

/**
 * Replace a `.workflow.ts` module with a client-safe stub. Scans for
 * `defineWorkflow('name', ...)` calls and emits a module that exports
 * `{ $tag: 'workflow', $name: 'name' }` for each — enough for the
 * client's `runWorkflow()` RPC but without pulling in `@syncengine/server`.
 */
function stubWorkflowModule(source: string): string {
    const exports: { exportName: string; workflowName: string }[] = [];
    // Match: export const <ident> = defineWorkflow('<name>', ...)
    const re = /export\s+const\s+(\w+)\s*=\s*defineWorkflow\(\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        exports.push({ exportName: m[1]!, workflowName: m[2]! });
    }
    if (exports.length === 0) {
        // Can't parse — return empty module rather than pulling in server deps.
        return '// workflow stub: no defineWorkflow calls found\n';
    }
    const lines = ['// Generated client stub — server code stripped by @syncengine/vite-plugin'];
    for (const { exportName, workflowName } of exports) {
        lines.push(
            `export const ${exportName} = { $tag: 'workflow', $name: ${JSON.stringify(workflowName)} };`,
        );
    }
    return lines.join('\n') + '\n';
}

// ── Heartbeat stub ─────────────────────────────────────────────────────────

/**
 * Replace a `.heartbeat.ts` module with a client-safe stub. Extracts
 * `heartbeat('name', { ...config })` calls and emits a module that exports
 * `{ $tag, $name, $scope, $trigger, $maxRuns, $runAtStart }` for each —
 * enough metadata for the client's `useHeartbeat()` hook to wire the
 * right RPC routes without pulling in `@syncengine/server`.
 *
 * The handler and interval grammar stay server-side; the client never
 * evaluates them.
 */
function stubHeartbeatModule(source: string, id: string): string {
    const exports: Array<{
        exportName: string;
        name: string;
        scope: string;
        trigger: string;
        maxRuns: number;
        runAtStart: boolean;
    }> = [];

    const callRe = /export\s+const\s+(\w+)\s*=\s*heartbeat\(\s*['"]([^'"]+)['"]\s*,\s*\{/g;
    for (const m of source.matchAll(callRe)) {
        const exportName = m[1]!;
        const name = m[2]!;
        const matchIndex = m.index ?? 0;
        const openBraceIdx = matchIndex + m[0].length - 1;
        const closeIdx = findBalancedClose(source, openBraceIdx, '{', '}');
        if (closeIdx === -1) continue;
        const body = source.slice(openBraceIdx + 1, closeIdx);

        exports.push({
            exportName,
            name,
            scope: extractStringField(body, 'scope') ?? 'workspace',
            trigger: extractStringField(body, 'trigger') ?? 'boot',
            maxRuns: extractNumberField(body, 'maxRuns') ?? 0,
            runAtStart: extractBoolField(body, 'runAtStart') ?? false,
        });
    }

    if (exports.length === 0) {
        // If the source clearly calls heartbeat() but our extractor
        // found nothing, the user likely passed a variable instead of
        // an inline config literal. Silently emitting an empty stub
        // would leave their `useHeartbeat(def)` import resolving to
        // undefined at runtime — a trap worse than a build error.
        if (/\bheartbeat\s*\(/.test(source)) {
            throw new Error(
                `[syncengine:vite-plugin] ${id}: found heartbeat() call but could not ` +
                `extract a config literal. Pass the config inline:\n\n` +
                `    export const myHeartbeat = heartbeat('myHeartbeat', {\n` +
                `        every: '30s',\n` +
                `        run: async (ctx) => { ... },\n` +
                `    });\n\n` +
                `The client bundle statically extracts $name, $scope, $trigger, ` +
                `$maxRuns, and $runAtStart from the config object literal; configs ` +
                `stored in a separate variable can't be analyzed.`,
            );
        }
        return '// heartbeat stub: no heartbeat() calls found\n';
    }
    const lines = ['// Generated client stub — server code stripped by @syncengine/vite-plugin'];
    for (const e of exports) {
        lines.push(
            `export const ${e.exportName} = {`,
            `    $tag: 'heartbeat',`,
            `    $name: ${JSON.stringify(e.name)},`,
            `    $scope: ${JSON.stringify(e.scope)},`,
            `    $trigger: ${JSON.stringify(e.trigger)},`,
            `    $maxRuns: ${e.maxRuns},`,
            `    $runAtStart: ${e.runAtStart},`,
            `};`,
        );
    }
    return lines.join('\n') + '\n';
}

// ── Webhook stub ───────────────────────────────────────────────────────────

/**
 * Replace a `.webhook.ts` module with a client-safe stub. The client
 * bundle never dispatches webhooks (external senders do) — we just
 * emit `{ $tag, $name, $path }` so any accidental import resolves
 * without pulling `@syncengine/server` into the browser.
 */
function stubWebhookModule(source: string, id: string): string {
    const exports: Array<{ exportName: string; name: string; path: string }> = [];

    const callRe = /export\s+const\s+(\w+)\s*=\s*webhook\(\s*['"]([^'"]+)['"]\s*,\s*\{/g;
    for (const m of source.matchAll(callRe)) {
        const exportName = m[1]!;
        const name = m[2]!;
        const matchIndex = m.index ?? 0;
        const openBraceIdx = matchIndex + m[0].length - 1;
        const closeIdx = findBalancedClose(source, openBraceIdx, '{', '}');
        if (closeIdx === -1) continue;
        const body = source.slice(openBraceIdx + 1, closeIdx);
        const path = extractStringField(body, 'path') ?? '';
        exports.push({ exportName, name, path });
    }

    if (exports.length === 0) {
        if (/\bwebhook\s*\(/.test(source)) {
            throw new Error(
                `[syncengine:vite-plugin] ${id}: found webhook() call but could not ` +
                `extract a config literal. Pass the config inline:\n\n` +
                `    export const myWebhook = webhook('myWebhook', {\n` +
                `        path: '/vendor/event',\n` +
                `        verify: { scheme: 'hmac-sha256', secret: () => process.env.SECRET! },\n` +
                `        ...\n` +
                `    });\n\n` +
                `Framework statically extracts $name and $path from the config object literal.`,
            );
        }
        return '// webhook stub: no webhook() calls found\n';
    }
    const lines = ['// Generated client stub — server code stripped by @syncengine/vite-plugin'];
    for (const e of exports) {
        lines.push(
            `export const ${e.exportName} = {`,
            `    $tag: 'webhook',`,
            `    $name: ${JSON.stringify(e.name)},`,
            `    $path: ${JSON.stringify(e.path)},`,
            `};`,
        );
    }
    return lines.join('\n') + '\n';
}

function extractStringField(body: string, field: string): string | null {
    const re = new RegExp(`(^|[,{\\s])${field}\\s*:\\s*['"]([^'"]+)['"]`);
    const m = body.match(re);
    return m ? m[2]! : null;
}

function extractNumberField(body: string, field: string): number | null {
    const re = new RegExp(`(^|[,{\\s])${field}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
    const m = body.match(re);
    if (!m) return null;
    const n = Number(m[2]);
    return Number.isFinite(n) ? n : null;
}

function extractBoolField(body: string, field: string): boolean | null {
    const re = new RegExp(`(^|[,{\\s])${field}\\s*:\\s*(true|false)`);
    const m = body.match(re);
    return m ? m[2] === 'true' : null;
}

// ── Dev middleware: /webhooks/* ─────────────────────────────────────────────

import {
    dispatchWebhook,
    findWebhook,
    isWebhook,
    type WebhookDef,
} from '@syncengine/server';
import type { ViteDevServer } from 'vite';

/**
 * Load every `.webhook.ts` file through Vite's SSR pipeline (so imports
 * resolve but server code isn't stubbed) and collect the exported defs.
 * Re-runs on every request so HMR edits to webhook files are picked up
 * without restart.
 */
async function loadWebhookDefs(
    server: ViteDevServer,
    webhookFiles: string[],
): Promise<WebhookDef[]> {
    const defs: WebhookDef[] = [];
    for (const file of webhookFiles) {
        try {
            const mod = await server.ssrLoadModule(file);
            for (const value of Object.values(mod)) {
                if (isWebhook(value)) defs.push(value);
            }
        } catch (err) {
            server.config.logger.error(
                `[syncengine:vite-plugin] failed to load ${file}: ${(err as Error).message}`,
            );
        }
    }
    return defs;
}

function buildFetchRequest(req: Connect.IncomingMessage, rawBody: string): Request {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }
    return new Request(url, {
        method: req.method ?? 'POST',
        headers,
        body: rawBody || null,
    });
}

export function buildWebhookMiddleware(
    server: ViteDevServer,
    webhookFiles: () => string[],
    restateUrlFn: () => string,
): Connect.NextHandleFunction {
    return async (req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/webhooks')) return next();
        const pathname = url.split('?')[0]!;

        if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: false, reason: 'webhooks accept POST only' }));
            return;
        }

        const defs = await loadWebhookDefs(server, webhookFiles());
        const def = findWebhook(pathname, defs);
        if (!def) {
            res.statusCode = 404;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: false, reason: `no webhook registered at ${pathname}` }));
            return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const request = buildFetchRequest(req, rawBody);
        const result = await dispatchWebhook(def, request, rawBody, restateUrlFn());
        res.statusCode = result.status;
        if (result.contentType) res.setHeader('content-type', result.contentType);
        res.end(result.body);
    };
}

// ── Dev middleware: /__syncengine/rpc/<entity>/<key>/<handler> ─────────────

/**
 * Build a Connect-style middleware that forwards
 * `/__syncengine/rpc/<entity>/<key>/<handler>` POSTs to the framework's
 * Restate entity runtime. The browser posts `[...args]` as the body;
 * we relay verbatim after validating the path components.
 *
 * The workspace id is read from the `x-syncengine-workspace` request
 * header — the client picked it up from the `<meta>` tag injected by
 * the workspaces sub-plugin, which resolved it from the user's
 * `syncengine.config.ts` on the HTML request. `workspaceIdFallbackFn`
 * is only consulted if the header is absent (older clients or direct
 * curl calls).
 */
export function buildRpcMiddleware(
    restateUrlFn: () => string,
    workspaceIdFallbackFn: () => string,
): Connect.NextHandleFunction {
    return async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/__syncengine/rpc/')) return next();
        if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end('Method Not Allowed');
            return;
        }

        const pathname = req.url.split('?')[0]!;
        const isWorkflow = pathname.startsWith('/__syncengine/rpc/workflow/');
        const isHeartbeat = pathname.startsWith('/__syncengine/rpc/heartbeat/');

        // Resolve workspace (shared validation)
        const wsResult = resolveWorkspaceId(
            req.headers['x-syncengine-workspace'],
            workspaceIdFallbackFn,
        );
        if (isRpcError(wsResult)) {
            res.statusCode = wsResult.status;
            res.end(wsResult.message);
            return;
        }

        // Resolve target URL (shared validation + URL construction)
        const target = isHeartbeat
            ? resolveHeartbeatTarget(pathname, wsResult, restateUrlFn())
            : isWorkflow
                ? resolveWorkflowTarget(pathname, wsResult, restateUrlFn())
                : resolveEntityTarget(pathname, wsResult, restateUrlFn());
        if (isRpcError(target)) {
            res.statusCode = target.status;
            res.end(target.message);
            return;
        }

        // Read body (Connect-specific)
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString('utf8') || ((isWorkflow || isHeartbeat) ? '{}' : '[]');

        const rpcAttrs = classifyRpcForSpan(pathname, wsResult, isWorkflow, isHeartbeat);

        await instrument.request(
            { method: 'POST', route: 'rpc', path: pathname },
            async () => instrument.rpc(rpcAttrs, async () => {
            // Proxy to Restate
            try {
                const upstream = await fetch(target.url, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        // W3C TraceContext — see serve/rpc.ts for the
                        // corresponding handler-side extraction.
                        ...instrument.traceHeaders(),
                    },
                    body,
                });
                const text = await upstream.text();
                res.statusCode = upstream.status;
                res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
                res.end(text);
            } catch (err) {
                res.statusCode = 502;
                res.setHeader('content-type', 'application/json');
                res.end(
                    JSON.stringify({
                        message: `[syncengine] failed to reach Restate at ${target.url}: ${(err as Error).message}`,
                    }),
                );
            }
        }));
    };
}

/** Mirror of classifyRpc in packages/serve/src/rpc.ts — kept local
 *  because vite-plugin resolves observe imports via the same bundler
 *  path and we don't want cross-package helpers for a 10-line parser. */
function classifyRpcForSpan(
    pathname: string,
    workspace: string,
    isWorkflow: boolean,
    isHeartbeat: boolean,
): { kind: 'entity' | 'workflow' | 'heartbeat'; name: string; handler?: string; workspace: string } {
    const prefix = '/__syncengine/rpc/';
    const rest = pathname.slice(prefix.length);
    if (isWorkflow) {
        const [name] = rest.slice('workflow/'.length).split('/');
        return { kind: 'workflow', name: name ?? 'unknown', workspace };
    }
    if (isHeartbeat) {
        const [name] = rest.slice('heartbeat/'.length).split('/');
        return { kind: 'heartbeat', name: name ?? 'unknown', workspace };
    }
    const parts = rest.split('/');
    return {
        kind: 'entity',
        name: parts[0] ?? 'unknown',
        handler: parts[2] ?? 'unknown',
        workspace,
    };
}

// ── Plugin factory ──────────────────────────────────────────────────────────

import { readDevRuntime } from './dev-runtime.ts';

export function actorsPlugin(opts: ActorsPluginOptions = {}): Plugin {
    const registry = emptyRegistry();
    let srcDir: string | null = null;
    let viteRoot: string | null = null;
    let isBuild = false;
    let outDir: string | null = null;

    return {
        name: 'syncengine:actors',

        configResolved(config) {
            viteRoot = config.root;
            srcDir = opts.srcDir ?? resolve(config.root, 'src');
            isBuild = config.command === 'build';
            outDir = config.build?.outDir
                ? resolve(config.root, config.build.outDir)
                : resolve(config.root, 'dist');
        },

        buildStart() {
            if (!srcDir) return;
            registry.byPath.clear();
            registry.paths.clear();
            const files = discoverActorFiles(srcDir);
            for (const absPath of files) {
                const relPath = absPath.startsWith(viteRoot ?? '')
                    ? absPath.slice((viteRoot?.length ?? 0) + 1)
                    : absPath;
                registry.byPath.set(absPath, { absPath, relPath });
                registry.paths.add(absPath);
            }
        },

        transform(code, id, options) {
            // SSR mode loads the real server code (used by the dev
            // /webhooks middleware to dispatch incoming requests);
            // client graph gets the stubbed, dependency-free version.
            const ssr = options?.ssr === true;

            // ── .workflow.ts: replace with a client-safe stub ──────────
            // Workflow files are server-only (they import @syncengine/server
            // which pulls in Node-only deps like nats). The client only
            // needs { $tag, $name } for runWorkflow() RPC calls, so we
            // replace the entire module with a lightweight stub that
            // preserves the export names and their $name values.
            if (id.endsWith('.workflow.ts')) {
                if (ssr) return null;
                return { code: stubWorkflowModule(code), map: null };
            }

            // ── .heartbeat.ts: replace with a client-safe stub ─────────
            // Heartbeat files import @syncengine/server (which pulls in
            // node-only deps). Client only needs the metadata fields to
            // wire useHeartbeat(def); handler + interval parser stay
            // server-side.
            if (id.endsWith('.heartbeat.ts')) {
                if (ssr) return null;
                return { code: stubHeartbeatModule(code, id), map: null };
            }

            // ── .webhook.ts: replace with a client-safe stub ───────────
            // Webhook files are server-only. Clients never dispatch them
            // (external senders do); stubbing prevents accidental imports
            // from pulling @syncengine/server into the bundle.
            if (id.endsWith('.webhook.ts')) {
                if (ssr) return null;
                return { code: stubWebhookModule(code, id), map: null };
            }

            if (!id.endsWith('.actor.ts')) return null;
            // Only transform files we discovered — otherwise unrelated
            // `.actor.ts` from deps could accidentally get stripped.
            if (!registry.paths.has(id)) return null;
            const transformed = stripServerCalls(code);
            if (transformed === code) return null;
            return { code: transformed, map: null };
        },

        configureServer(server) {
            // The fallback workspace id used when an incoming RPC
            // request doesn't carry an `x-syncengine-workspace` header
            // (curl calls, tests, older clients). Hashing `'default'`
            // gives the same wsKey the workspaces sub-plugin's default
            // resolver produces for apps without a syncengine.config.ts,
            // so the two paths stay consistent. Post-Phase-8 the CLI
            // no longer writes `workspaceId` into runtime.json, and
            // ActorsPluginOptions no longer exposes workspaceId, so
            // this hashed default is the only fallback that makes sense.
            const fallbackWsKey = hashWorkspaceId('default');
            const restateUrlFn = () =>
                opts.restateUrl ??
                readDevRuntime(viteRoot ?? server.config.root).restateUrl ??
                'http://localhost:8080';

            const middleware = buildRpcMiddleware(
                restateUrlFn,
                () => fallbackWsKey,
            );
            server.middlewares.use(middleware);

            // /webhooks/* — external senders. We re-derive the webhook
            // file list from the registry on each request so HMR-added
            // files work without a restart.
            const webhookMw = buildWebhookMiddleware(
                server,
                () =>
                    Array.from(registry.paths).filter((p) => p.endsWith('.webhook.ts')),
                restateUrlFn,
            );
            server.middlewares.use(webhookMw);
        },

        // ── Phase 9: emit server manifest during production build ──
        closeBundle() {
            if (!isBuild || !outDir || !viteRoot) return;

            const actors = Array.from(registry.byPath.values()).map((a) => a.relPath);
            const manifest = {
                actors,
                configCandidates: [
                    'syncengine.config.ts',
                    'syncengine.config.js',
                    'syncengine.config.mjs',
                ],
            };
            const manifestDir = join(outDir, '.syncengine');
            mkdirSync(manifestDir, { recursive: true });
            writeFileSync(
                join(manifestDir, 'manifest.json'),
                JSON.stringify(manifest, null, 2),
            );
        },
    };
}
