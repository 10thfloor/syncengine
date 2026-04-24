/**
 * Source-tarball cache + symlink management.
 *
 * syncengine's framework source ships as a tarball attached to each
 * GitHub Release (alongside the CLI binary). We don't publish to JSR
 * or npm — the framework is distributed with the binary and resolved
 * into user projects through plain Node module resolution.
 *
 * Flow:
 *   1. User runs `syncengine init` → we write `.syncengine/release`
 *      with the CLI's compiled-in VERSION.
 *   2. CLI ensures `~/.syncengine/source/<version>/` exists, downloading
 *      the release tarball from GitHub if not.
 *   3. Project-local `.syncengine/source` symlinks into that cache.
 *   4. `node_modules/@syncengine/*` symlinks point at the individual
 *      package directories under `.syncengine/source/packages/*`, so
 *      `import { entity } from '@syncengine/core'` resolves via
 *      standard Node resolution — no tsconfig paths, no Vite alias
 *      magic required.
 *
 * Monorepo members (kitchen-sink, notepad): we detect the pnpm
 * workspace root and skip the whole cache/symlink dance — the
 * workspace's own `node_modules/@syncengine/*` symlinks already do
 * the right thing via `workspace:*`.
 */

import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { errors, CliCode } from '@syncengine/core';

/** Packages that get symlinked into the user's node_modules on init/dev.
 *  Mirrors what a scaffolded app might import. Unlisted workspace
 *  members (bin-utils, nats-bin, etc.) are resolved via the internal
 *  packages' own relative imports inside the source tree. */
const PUBLIC_PACKAGES = [
    'core',
    'client',
    'server',
    'vite-plugin',
] as const;

/** Internal packages referenced via bare specifier from the public
 *  packages above. Users don't import these directly, but Node's
 *  resolver needs them present in node_modules so the cascading
 *  imports from e.g. @syncengine/server → @syncengine/http-core work. */
const INTERNAL_PACKAGES = [
    'http-core',
    'gateway-core',
    'observe',
    'dbsp',          // wasm-pack output, special-cased below
] as const;

export interface SourceLayout {
    /** Absolute path to the source root for this version. Contains `packages/`. */
    readonly root: string;
    /** Absolute path to each package: map of short-name → dir. */
    readonly packages: Readonly<Record<string, string>>;
}

/** Read `.syncengine/release` from the user's project. Returns the
 *  pinned version, or null if not yet initialized. */
export function readRelease(appDir: string): string | null {
    const path = join(appDir, '.syncengine', 'release');
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8').trim();
}

/** Write `.syncengine/release` with the given version. */
export function writeRelease(appDir: string, version: string): void {
    const dir = join(appDir, '.syncengine');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'release'), `${version}\n`);
}

/** Root of the machine-wide source cache — one subdir per version. */
export function sourceCacheRoot(): string {
    return join(homedir(), '.syncengine', 'source');
}

/** Absolute directory for a specific cached version. */
export function versionedCacheDir(version: string): string {
    return join(sourceCacheRoot(), version);
}

/** Locate the source root for a pinned version, downloading and
 *  extracting the tarball from GitHub Releases if necessary. */
export async function ensureSourceCached(
    version: string,
    opts: { repo?: string; skipDownload?: boolean } = {},
): Promise<SourceLayout> {
    const repo = opts.repo ?? '10thfloor/syncengine';
    const cacheDir = versionedCacheDir(version);
    const marker = join(cacheDir, '.ready');

    if (!existsSync(marker)) {
        if (opts.skipDownload) {
            throw errors.cli(CliCode.DEPENDENCY_NOT_FOUND, {
                message: `syncengine source for v${version} is not cached at ${cacheDir}.`,
                hint: `Run \`syncengine dev\` at least once to download it, or pass --fetch-source explicitly.`,
            });
        }
        await downloadAndExtract(version, repo, cacheDir);
        writeFileSync(marker, new Date().toISOString());
    }

    return buildLayout(cacheDir);
}

/** Walk up from `start` looking for a pnpm-workspace.yaml. Returns
 *  the directory it's in, or null if none found before the filesystem
 *  root. */
export function findWorkspaceRoot(start: string): string | null {
    let dir = resolve(start);
    for (let i = 0; i < 20; i++) {
        if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

/** One-call setup: ensure appDir is ready to use syncengine at runtime.
 *  Always links `node_modules/@syncengine/*` — either at the live
 *  workspace packages (monorepo dev) or at the cached source tarball
 *  (standalone install). Cheap on repeat runs; readlink-compares and
 *  short-circuits when everything's already correct.
 *
 *  Preference order:
 *    1. `.syncengine/release` pin present → standalone; use cached tarball.
 *    2. Ancestor pnpm-workspace.yaml with `packages/core`, etc. → monorepo
 *       dev; use the live sources directly.
 *    3. Neither → fail with a hint pointing at `syncengine init`. */
export async function setupAppForRun(appDir: string): Promise<void> {
    const pinnedVersion = readRelease(appDir);
    if (pinnedVersion) {
        const layout = await ensureSourceCached(pinnedVersion);
        linkSourceIntoProject(appDir, layout);
        return;
    }

    const wsRoot = findWorkspaceRoot(appDir);
    if (wsRoot) {
        const layout = workspaceLayoutFrom(wsRoot);
        if (layout) {
            linkSourceIntoProject(appDir, layout);
            return;
        }
    }

    throw errors.cli(CliCode.APP_DIR_NOT_FOUND, {
        message: `No .syncengine/release pin found in ${appDir}, and not inside a pnpm workspace with framework packages.`,
        hint: `Run \`syncengine init\` from this directory.`,
    });
}

/** Pre-existing workspace layout (in-repo development). Detected when
 *  a pnpm-workspace.yaml is found in an ancestor and it lists the
 *  usual packages. */
export function workspaceLayoutFrom(repoRoot: string): SourceLayout | null {
    const pkgsDir = join(repoRoot, 'packages');
    if (!existsSync(pkgsDir)) return null;
    const packages: Record<string, string> = {};
    for (const name of [...PUBLIC_PACKAGES, ...INTERNAL_PACKAGES]) {
        const candidate = name === 'dbsp'
            ? join(repoRoot, 'packages', 'dbsp-engine', 'pkg')
            : join(pkgsDir, name);
        if (existsSync(candidate)) packages[name] = candidate;
    }
    if (Object.keys(packages).length === 0) return null;
    return { root: repoRoot, packages };
}

function buildLayout(cacheDir: string): SourceLayout {
    const pkgsDir = join(cacheDir, 'packages');
    const packages: Record<string, string> = {};
    for (const name of [...PUBLIC_PACKAGES, ...INTERNAL_PACKAGES]) {
        const candidate = name === 'dbsp'
            ? join(cacheDir, 'packages', 'dbsp-engine', 'pkg')
            : join(pkgsDir, name);
        if (!existsSync(candidate)) {
            throw errors.cli(CliCode.DEPENDENCY_NOT_FOUND, {
                message: `Source tarball at ${cacheDir} is missing packages/${name}/`,
                hint: `Delete ${cacheDir} and retry — the tarball may be truncated.`,
            });
        }
        packages[name] = candidate;
    }
    return { root: cacheDir, packages };
}

/** Ensure the project-local `.syncengine/source` symlink and the
 *  `node_modules/@syncengine/*` symlinks point at `layout`. Called
 *  from init and re-verified on every dev/build/start so a manual
 *  `pnpm install` doesn't silently break resolution. */
export function linkSourceIntoProject(appDir: string, layout: SourceLayout): void {
    // 1. `.syncengine/source` → layout.root
    const localSource = join(appDir, '.syncengine', 'source');
    mkdirSync(dirname(localSource), { recursive: true });
    replaceSymlink(localSource, layout.root);

    // 2. `node_modules/@syncengine/<pkg>` → layout.packages[pkg]
    const scopeDir = join(appDir, 'node_modules', '@syncengine');
    mkdirSync(scopeDir, { recursive: true });
    for (const [name, dir] of Object.entries(layout.packages)) {
        replaceSymlink(join(scopeDir, name), dir);
    }
}

function replaceSymlink(linkPath: string, target: string): void {
    try {
        const existing = readlinkSync(linkPath);
        if (resolve(dirname(linkPath), existing) === resolve(target)) return;
    } catch {
        // link missing or not a symlink — fall through to recreate
    }
    try { rmSync(linkPath, { recursive: true, force: true }); } catch { /* ignore */ }
    symlinkSync(target, linkPath, 'dir');
}

// ── Tarball download ──────────────────────────────────────────────────────

async function downloadAndExtract(version: string, repo: string, destDir: string): Promise<void> {
    const url = `https://github.com/${repo}/releases/download/v${version}/syncengine-source-${version}.tar.gz`;
    const sumsUrl = `https://github.com/${repo}/releases/download/v${version}/SHA256SUMS`;

    mkdirSync(destDir, { recursive: true });
    const tarPath = join(destDir, '.tarball.tar.gz');

    process.stdout.write(`  fetching syncengine source v${version}...\n`);

    // Download tarball
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw errors.cli(CliCode.DEPENDENCY_NOT_FOUND, {
            message: `failed to download source tarball: HTTP ${res.status} ${res.statusText}`,
            hint: `URL: ${url}. The release may not exist yet.`,
        });
    }
    await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(tarPath));

    // Verify hash if SHA256SUMS is available
    try {
        const sums = await (await fetch(sumsUrl)).text();
        const actual = hashFile(tarPath);
        const line = sums.split('\n').find((l) => l.includes(`syncengine-source-${version}.tar.gz`));
        if (line) {
            const [expected] = line.trim().split(/\s+/);
            if (expected !== actual) {
                rmSync(tarPath, { force: true });
                throw errors.cli(CliCode.DEPENDENCY_NOT_FOUND, {
                    message: `source tarball hash mismatch: expected ${expected}, got ${actual}`,
                    hint: `The cached file has been removed; retry to re-download.`,
                });
            }
        }
    } catch (err) {
        // If this is our own hash-mismatch error, propagate.
        if (err instanceof Error && /hash mismatch/.test(err.message)) throw err;
        // Otherwise the SHA256SUMS fetch was just best-effort — warn, continue.
        process.stderr.write(`  (could not verify hash: ${err instanceof Error ? err.message : String(err)})\n`);
    }

    // Extract into destDir, stripping the top-level `syncengine-source-<v>/`
    // dir from the archive so `<destDir>/packages/*` is the final shape.
    await new Promise<void>((ok, fail) => {
        const child = spawn('tar', ['-xzf', tarPath, '-C', destDir, '--strip-components=1'], { stdio: 'inherit' });
        child.on('exit', (code) => (code === 0 ? ok() : fail(errors.cli(CliCode.DEPENDENCY_NOT_FOUND, {
            message: `tar exited with code ${code}`,
        }))));
        child.on('error', fail);
    });

    rmSync(tarPath, { force: true });

    // Materialize framework deps (restate-sdk, nats clients, etc.) inside
    // the cache so Node's symlink-following resolution finds them when a
    // user project imports from `node_modules/@syncengine/server`.
    process.stdout.write(`  installing framework deps into cache...\n`);
    await new Promise<void>((ok, fail) => {
        const child = spawn('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: destDir, stdio: 'inherit' });
        child.on('exit', (code) => (code === 0 ? ok() : fail(errors.cli(CliCode.DEPENDENCY_NOT_FOUND, {
            message: `pnpm install in ${destDir} exited with code ${code}`,
            hint: `Ensure pnpm is on PATH. Try: corepack enable && pnpm --version`,
        }))));
        child.on('error', fail);
    });
}

function hashFile(path: string): string {
    const hash = createHash('sha256');
    hash.update(readFileSync(path));
    return hash.digest('hex');
}
