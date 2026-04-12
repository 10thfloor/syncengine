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

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';

import { hashWorkspaceId } from '@syncengine/core/http';
import {
    resolveWorkspaceId,
    resolveWorkflowTarget,
    resolveEntityTarget,
    isRpcError,
} from '@syncengine/server/rpc-proxy';

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
            } else if (st.isFile() && name.endsWith('.actor.ts')) {
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
    //
    // The old transform replaced every handler with `(s) => s`, making
    // optimistic updates no-ops. Now that handlers are preserved, the
    // UI shows the expected new state immediately — zero flicker.
    //
    // The scan infrastructure below is retained (commented out) for a
    // future selective-strip phase that may remove emit() side-effects
    // or other server-only code from the client bundle.
    return source;

    /* eslint-disable no-unreachable */
    let out = source;
    let cursor = 0;
    while (true) {
        // Match both `entity(` and the legacy `defineEntity(` call forms.
        const idxEntity = out.indexOf('entity(', cursor);
        const idxDefine = out.indexOf('defineEntity(', cursor);
        const idx = idxEntity === -1 ? idxDefine
            : idxDefine === -1 ? idxEntity
            : Math.min(idxEntity, idxDefine);
        if (idx === -1) break;

        const matchLen = out.startsWith('defineEntity(', idx) ? 'defineEntity('.length : 'entity('.length;

        // Word-boundary check so we don't match `myEntity(` or `myDefineEntity(`.
        const prev = idx === 0 ? '' : out[idx - 1]!;
        if (/[A-Za-z0-9_$]/.test(prev)) { cursor = idx + 1; continue; }

        const openParen = idx + matchLen - 1;
        const callEnd = findBalancedClose(out, openParen, '(', ')');
        if (callEnd === -1) { cursor = idx + 1; continue; }

        // Find the config object literal — it's either the second
        // positional arg (after a name+comma) or the first, depending
        // on the API shape. Walk forward looking for an `{` at the
        // top level of this call.
        const callBody = out.slice(openParen + 1, callEnd);
        const relConfigStart = findTopLevelBrace(callBody);
        if (relConfigStart === -1) { cursor = callEnd + 1; continue; }
        const configStart = openParen + 1 + relConfigStart;
        const configEnd = findBalancedClose(out, configStart, '{', '}');
        if (configEnd === -1) { cursor = callEnd + 1; continue; }

        // Find the `handlers:` property inside the config literal.
        const configBody = out.slice(configStart + 1, configEnd);
        const handlersRel = findHandlersProperty(configBody);
        if (!handlersRel) { cursor = callEnd + 1; continue; }

        // `handlersRel.valueStart` is the index (inside configBody) of
        // the first non-whitespace character after `handlers:`. The
        // value must be an object literal `{...}`; any other form
        // (e.g., an external variable) can't be statically stripped
        // and is passed through unchanged.
        const braceStart = configStart + 1 + handlersRel.valueStart;
        if (out[braceStart] !== '{') { cursor = callEnd + 1; continue; }
        const braceEnd = findBalancedClose(out, braceStart, '{', '}');
        if (braceEnd === -1) { cursor = callEnd + 1; continue; }

        const body = out.slice(braceStart + 1, braceEnd);
        const handlerNames = extractHandlerNames(body);
        if (handlerNames.length === 0) {
            cursor = callEnd + 1;
            continue;
        }

        // Build the stub and splice it in place of just the braced
        // handler literal.
        const stub = buildStubLiteral(handlerNames);
        out = out.slice(0, braceStart) + stub + out.slice(braceEnd + 1);
        // Advance past the replacement. `callEnd` has shifted; recompute
        // the scanning cursor conservatively.
        cursor = braceStart + stub.length;
    }
    return out;
}

/**
 * Find the index of the first top-level `{` inside a call body (i.e.,
 * at depth 0 with respect to parens/brackets, skipping strings and
 * comments). Returns -1 if not found.
 */
function findTopLevelBrace(src: string): number {
    let i = 0;
    while (i < src.length) {
        const c = src[i]!;
        if (c === '/' && src[i + 1] === '/') {
            const nl = src.indexOf('\n', i);
            if (nl === -1) return -1;
            i = nl + 1;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            if (end === -1) return -1;
            i = end + 2;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const end = skipString(src, i, c);
            if (end === -1) return -1;
            i = end;
            continue;
        }
        if (c === '(' || c === '[') {
            const pairClose = c === '(' ? ')' : ']';
            const end = findBalancedClose(src, i, c, pairClose);
            if (end === -1) return -1;
            i = end + 1;
            continue;
        }
        if (c === '{') return i;
        i++;
    }
    return -1;
}

/**
 * Scan a top-level object-literal body for a `handlers` property and
 * return the index where its value starts (skipping the colon and any
 * whitespace). Returns `null` if no such property is found.
 */
function findHandlersProperty(body: string): { valueStart: number } | null {
    let i = 0;
    while (i < body.length) {
        // Skip whitespace/commas/comments
        while (i < body.length && /[\s,]/.test(body[i]!)) i++;
        if (i < body.length && body[i] === '/' && body[i + 1] === '/') {
            const nl = body.indexOf('\n', i);
            if (nl === -1) return null;
            i = nl + 1;
            continue;
        }
        if (i < body.length && body[i] === '/' && body[i + 1] === '*') {
            const end = body.indexOf('*/', i + 2);
            if (end === -1) return null;
            i = end + 2;
            continue;
        }
        if (i >= body.length) return null;

        // Parse a property name (identifier or string literal)
        let name: string | null = null;
        const nameStart = i;
        if (body[i] === '"' || body[i] === "'") {
            const quote = body[i]!;
            const end = body.indexOf(quote, i + 1);
            if (end === -1) return null;
            name = body.slice(i + 1, end);
            i = end + 1;
        } else {
            const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(i));
            if (match) {
                name = match[0];
                i += name.length;
            }
        }
        if (!name) { i++; continue; }

        while (i < body.length && /\s/.test(body[i]!)) i++;

        if (body[i] === ':' && name === 'handlers') {
            i++;
            while (i < body.length && /\s/.test(body[i]!)) i++;
            return { valueStart: i };
        }

        // Otherwise skip this property's value and continue
        if (body[i] === ':') {
            i++;
            // Skip to the next top-level comma
            while (i < body.length) {
                const c = body[i]!;
                if (c === ',') break;
                if (c === '(' || c === '{' || c === '[') {
                    const pairClose = c === '{' ? '}' : c === '(' ? ')' : ']';
                    const end = findBalancedClose(body, i, c, pairClose);
                    if (end === -1) return null;
                    i = end + 1;
                    continue;
                }
                if (c === '"' || c === "'" || c === '`') {
                    const end = skipString(body, i, c);
                    if (end === -1) return null;
                    i = end;
                    continue;
                }
                i++;
            }
        } else if (body[i] === '(') {
            // Shorthand method — skip params and body
            const parenEnd = findBalancedClose(body, i, '(', ')');
            if (parenEnd === -1) return null;
            i = parenEnd + 1;
            while (i < body.length && /\s/.test(body[i]!)) i++;
            if (body[i] === '{') {
                const end = findBalancedClose(body, i, '{', '}');
                if (end === -1) return null;
                i = end + 1;
            }
        } else {
            // Unknown shape — advance past the name to avoid infinite loop
            i = Math.max(i + 1, nameStart + 1);
        }
    }
    return null;
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

/**
 * Extract top-level method/property names from the braced body of a
 * `server({...})` argument. Handles shorthand methods, async shorthand,
 * keyed arrows, and function expressions.
 */
function extractHandlerNames(body: string): string[] {
    const names = new Set<string>();
    let i = 0;
    while (i < body.length) {
        // Skip whitespace, commas, and comments
        while (i < body.length && /[\s,]/.test(body[i]!)) i++;
        if (i < body.length && body[i] === '/' && body[i + 1] === '/') {
            const nl = body.indexOf('\n', i);
            if (nl === -1) break;
            i = nl + 1;
            continue;
        }
        if (i < body.length && body[i] === '/' && body[i + 1] === '*') {
            const end = body.indexOf('*/', i + 2);
            if (end === -1) break;
            i = end + 2;
            continue;
        }
        if (i >= body.length) break;

        // Skip `async ` modifier
        if (body.slice(i, i + 6) === 'async ') i += 6;
        while (i < body.length && /\s/.test(body[i]!)) i++;

        // Parse an identifier or string-literal key
        let name: string | null = null;
        if (body[i] === '"' || body[i] === "'") {
            const quote = body[i]!;
            const end = body.indexOf(quote, i + 1);
            if (end === -1) break;
            name = body.slice(i + 1, end);
            i = end + 1;
        } else {
            const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(i));
            if (match) {
                name = match[0];
                i += name.length;
            }
        }
        if (!name) { i++; continue; }

        while (i < body.length && /\s/.test(body[i]!)) i++;

        const sep = body[i];
        if (sep !== '(' && sep !== ':') { continue; }
        names.add(name);

        if (sep === '(') {
            // method shorthand: skip params then body
            const parenEnd = findBalancedClose(body, i, '(', ')');
            if (parenEnd === -1) break;
            i = parenEnd + 1;
            while (i < body.length && /\s/.test(body[i]!)) i++;
            if (body[i] === '{') {
                const end = findBalancedClose(body, i, '{', '}');
                if (end === -1) break;
                i = end + 1;
            }
        } else {
            // `name:` — skip the value by advancing to the next top-level
            // comma, stepping over any nested brackets/strings.
            i++;
            let j = i;
            while (j < body.length) {
                const c = body[j]!;
                if (c === ',') break;
                if (c === '(' || c === '{' || c === '[') {
                    const pairClose = c === '{' ? '}' : c === '(' ? ')' : ']';
                    const end = findBalancedClose(body, j, c, pairClose);
                    if (end === -1) { j = body.length; break; }
                    j = end + 1;
                    continue;
                }
                if (c === '"' || c === "'" || c === '`') {
                    const end = skipString(body, j, c);
                    if (end === -1) { j = body.length; break; }
                    j = end;
                    continue;
                }
                j++;
            }
            i = j;
        }
    }
    return Array.from(names);
}

function buildStubLiteral(handlerNames: readonly string[]): string {
    // The stub is a no-op: each handler returns its input state unchanged.
    // This keeps the client-side latency-compensation path (see
    // packages/client/src/entity-client.ts) working — it runs the handler
    // locally, gets the same state back, treats that as the "optimistic"
    // layer (no change), then POSTs to the RPC middleware for the
    // authoritative server-side result. When the POST resolves the UI
    // reflects the real new state.
    //
    // The emitted literal is PLAIN JAVASCRIPT — no TypeScript annotations.
    // This transform runs inside Vite's pipeline AFTER esbuild has already
    // stripped TypeScript from the source, so injecting `(s: T) => ...`
    // syntax back in breaks the downstream JS parser. See:
    // https://vite.dev/guide/api-plugin.html#transformers-and-plugins
    //
    // A future phase may expose a client-safe subset of handlers (pure
    // functions that can actually run in the browser for true latency
    // compensation), in which case the stub would import them directly.
    const entries = handlerNames
        .map((n) => `    ${JSON.stringify(n)}: (s) => s`)
        .join(',\n');
    return `{\n${entries}\n  }`;
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
        const target = isWorkflow
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
        const body = Buffer.concat(chunks).toString('utf8') || (isWorkflow ? '{}' : '[]');

        // Proxy to Restate
        try {
            const upstream = await fetch(target.url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
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
    };
}

// ── Plugin factory ──────────────────────────────────────────────────────────

/** Runtime-config dual: the dev orchestrator writes this file with the
 *  allocated Restate / NATS URLs. Post-Phase-8 the `workspaceId` field
 *  is no longer written — workspaces are resolved per request by the
 *  workspaces sub-plugin. */
interface DevRuntimeJson {
    natsUrl?: string;
    restateUrl?: string;
    authToken?: string | null;
}

function readDevRuntime(root: string): DevRuntimeJson {
    const path = resolve(root, '.syncengine', 'dev', 'runtime.json');
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as DevRuntimeJson;
    } catch {
        return {};
    }
}

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

        transform(code, id) {
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
            const middleware = buildRpcMiddleware(
                () => opts.restateUrl ?? readDevRuntime(viteRoot ?? server.config.root).restateUrl ?? 'http://localhost:8080',
                () => fallbackWsKey,
            );
            server.middlewares.use(middleware);
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
