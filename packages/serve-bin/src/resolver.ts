import { existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { errors, CliCode } from '@syncengine/core';

export interface CompileArgs {
    readonly source: string;   // absolute path to serve's src/index.ts
    readonly outPath: string;  // where to place the compiled binary
}

export interface ResolveOptions {
    /** Where binaries live on disk. Typically
     *  `~/.cache/syncengine/bin/serve/<version>/`. */
    readonly cacheDir: string;
    /** Monorepo root (pnpm-workspace.yaml dir), or null if running
     *  outside a workspace. */
    readonly workspaceRoot: string | null;
    /** Called when we need to produce a binary from source. Injected so
     *  tests can stub the actual `bun build --compile` shell-out. */
    readonly compile: (args: CompileArgs) => Promise<string>;
}

export type Resolution =
    | {
        /** Run this executable directly. Production path — compiled
         *  binary or a downloaded release. */
        readonly kind: 'binary';
        readonly path: string;
    }
    | {
        /** Run the TypeScript source via `bun run <path>`. Monorepo dev
         *  path — skips compilation entirely, avoids macOS Gatekeeper
         *  issues with unsigned binaries, and gets hot source changes
         *  without a rebuild. */
        readonly kind: 'source';
        readonly path: string;
    };

const BIN_NAME = 'syncengine-serve';

/**
 * Resolve how to run the syncengine-serve entrypoint.
 *
 * Order of attempts:
 *   1. Cache hit — returns a pre-compiled binary if present and
 *      (if source exists) it's not stale.
 *   2. Local source — if we're inside the monorepo, return the TS
 *      source path and let the caller spawn it via `bun run`. Skips
 *      compile entirely — faster startup and sidesteps the macOS
 *      Gatekeeper kill-137 problem for unsigned bun-compiled binaries.
 *   3. (Future) Download from a pinned GitHub release; after release
 *      binaries land, this becomes the fallback.
 *
 * `compile` is still wired up — callers can force a compile path for
 * deployment testing by asking for it specifically.
 */
export async function resolveBinaryPath(opts: ResolveOptions): Promise<string> {
    const resolution = await resolve(opts);
    if (resolution.kind !== 'binary') {
        throw errors.cli(CliCode.BINARY_NOT_FOUND, {
            message: `expected a compiled binary; got source path ${resolution.path}. Use resolveForRun() to get a ready-to-spawn Resolution.`,
        });
    }
    return resolution.path;
}

/**
 * Higher-level resolver: returns a Resolution the caller can dispatch
 * on. Monorepo callers get 'source' and spawn via bun; production
 * callers get 'binary' and exec directly.
 */
export async function resolveForRun(opts: ResolveOptions): Promise<Resolution> {
    return resolve(opts);
}

async function resolve(opts: ResolveOptions): Promise<Resolution> {
    const binPath = join(opts.cacheDir, BIN_NAME);
    const source = opts.workspaceRoot
        ? sourceForWorkspace(opts.workspaceRoot)
        : null;

    // 1. Cache hit that's not stale against source.
    if (existsSync(binPath) && (!source || !isSourceNewer(source, binPath))) {
        return { kind: 'binary', path: binPath };
    }

    // 2. Source-run in the monorepo — skip compile, faster + works on
    //    macOS without signing.
    if (source) {
        return { kind: 'source', path: source };
    }

    // 3. No binary, no source. In the future this is where downloads
    //    from the pinned release slot in. Until those ship, the
    //    compile callback is the last resort.
    if (existsSync(binPath)) {
        return { kind: 'binary', path: binPath };
    }

    mkdirSync(dirname(binPath), { recursive: true });
    try {
        const compiled = await opts.compile({
            source: '', // no source available
            outPath: binPath,
        });
        return { kind: 'binary', path: compiled };
    } catch (err) {
        throw errors.cli(CliCode.BINARY_NOT_FOUND, {
            message: `syncengine-serve binary not found at ${binPath} and no source available to compile`,
            hint:
                `Run \`syncengine build\` first or install @syncengine/serve-bin from a release ` +
                `that ships prebuilt binaries.`,
            context: { cacheDir: opts.cacheDir },
            cause: err instanceof Error ? err : new Error(String(err)),
        });
    }
}

/**
 * Walk up from `startDir` looking for a pnpm-workspace.yaml. Returns
 * the directory containing it, or null if none is found within 16
 * levels. 16 is a safety cap — workspaces are always shallow.
 */
export function findWorkspaceRoot(startDir: string): string | null {
    let dir = startDir;
    for (let i = 0; i < 16; i++) {
        if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

function sourceForWorkspace(workspaceRoot: string): string | null {
    const src = join(workspaceRoot, 'packages/serve/src/index.ts');
    return existsSync(src) ? src : null;
}

function isSourceNewer(source: string, binary: string): boolean {
    try {
        const srcMtime = statSync(source).mtimeMs;
        const binMtime = statSync(binary).mtimeMs;
        return srcMtime > binMtime;
    } catch {
        return false;
    }
}
