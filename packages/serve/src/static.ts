import { readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative, extname } from 'node:path';

export interface StaticHandlerOptions {
    /** Absolute path to the dist directory to serve from. */
    readonly distDir: string;
    /** Asset prefix that's ALWAYS treated as static (serves from distDir).
     *  Default '/assets/'. */
    readonly assetsPrefix?: string;
}

export type StaticHandler = (req: Request) => Promise<Response | null>;

/**
 * Build a static-file handler rooted at `distDir`. Returns `null` for
 * paths that don't look static (no extension, or not under the assets
 * prefix, or not GET/HEAD) so the HTML handler can take them.
 *
 * Precomputes ETags for every file in `distDir` at startup so per-request
 * work is: path-resolve, fs stat, maybe 304, stream file. No hashing
 * under load.
 */
export async function createStaticHandler(
    opts: StaticHandlerOptions,
): Promise<StaticHandler> {
    const distRoot = resolve(opts.distDir);
    const assetsPrefix = opts.assetsPrefix ?? '/assets/';
    const etags = await buildEtagMap(distRoot);
    const hashedAssetRe = /-[a-f0-9]{8,}\.(js|css|map|mjs|woff2?|png|jpg|jpeg|svg|webp|avif)$/i;

    return async (req: Request): Promise<Response | null> => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return null;

        const url = new URL(req.url);
        const pathname = url.pathname;

        // Paths without an extension and outside the assets prefix get
        // punted to the HTML handler (SPA fallthrough).
        const hasExt = extname(pathname).length > 0;
        const isAsset = pathname.startsWith(assetsPrefix);
        if (!hasExt && !isAsset) return null;
        if (pathname === '/') return null;

        // Path-traversal guard: resolve the joined path and assert it
        // still lives under distRoot. `..` segments are collapsed by
        // resolve(); an escape attempt ends up outside distRoot and
        // gets rejected here.
        const joined = resolve(distRoot, '.' + pathname);
        const rel = relative(distRoot, joined);
        if (rel.startsWith('..') || rel.startsWith('/')) {
            return new Response('not found', { status: 404 });
        }

        const file = Bun.file(joined);
        if (!(await file.exists())) {
            return new Response('not found', { status: 404 });
        }

        const etag = etags.get(rel);
        const headers = new Headers();
        headers.set('content-type', file.type);
        if (etag) headers.set('etag', etag);

        // Cache: immutable for hashed filenames (Vite emits *-[hash].ext);
        // no-cache for everything else to avoid serving stale assets.
        if (hashedAssetRe.test(pathname)) {
            headers.set('cache-control', 'public, max-age=31536000, immutable');
        } else {
            headers.set('cache-control', 'public, no-cache');
        }

        // Conditional request.
        if (etag && req.headers.get('if-none-match') === etag) {
            return new Response(null, { status: 304, headers });
        }

        if (req.method === 'HEAD') {
            return new Response(null, { status: 200, headers });
        }
        return new Response(file, { status: 200, headers });
    };
}

/**
 * Walk distDir at startup, compute a truncated SHA-256 of each file's
 * bytes, and return a map from relative path → weak ETag. Cached for
 * the process lifetime — files in dist/ don't change after deploy.
 */
async function buildEtagMap(distRoot: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const files: string[] = [];
    const collect = (dir: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
            const full = join(dir, name);
            let st;
            try {
                st = statSync(full);
            } catch {
                continue;
            }
            if (st.isDirectory()) collect(full);
            else if (st.isFile()) files.push(full);
        }
    };
    collect(distRoot);
    for (const full of files) {
        const bytes = new Uint8Array(await Bun.file(full).arrayBuffer());
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
        map.set(relative(distRoot, full), `W/"${hash}"`);
    }
    return map;
}
