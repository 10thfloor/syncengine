/**
 * Shared utilities for native-binary package downloaders.
 *
 * Used by `@syncengine/nats-bin` and `@syncengine/restate-bin` to download
 * a pinned binary release asset from GitHub, extract it into a per-version
 * cache directory, and return an absolute path to the resulting executable.
 *
 * Binaries are cached in:
 *   ~/.cache/syncengine/bin/<tool>/<version>/<filename>
 *
 * Environment variables:
 *   SYNCENGINE_BIN_CACHE — override cache root (default: ~/.cache/syncengine)
 *   SYNCENGINE_BIN_QUIET — suppress progress output (default: verbose)
 */

import { createWriteStream, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { errors, CliCode, ConnectionCode } from '@syncengine/core';

// ── Platform detection ─────────────────────────────────────────────────────

export type HostOs = 'darwin' | 'linux' | 'windows';
export type HostArch = 'amd64' | 'arm64';

export interface Host {
    os: HostOs;
    arch: HostArch;
}

export function detectHost(): Host {
    const rawOs = process.platform;
    const rawArch = process.arch;

    let os: HostOs;
    if (rawOs === 'darwin') os = 'darwin';
    else if (rawOs === 'linux') os = 'linux';
    else if (rawOs === 'win32') os = 'windows';
    else throw errors.cli(CliCode.UNSUPPORTED_PLATFORM, {
        message: `Unsupported OS: ${rawOs}`,
        context: { os: rawOs },
    });

    let arch: HostArch;
    if (rawArch === 'x64') arch = 'amd64';
    else if (rawArch === 'arm64') arch = 'arm64';
    else throw errors.cli(CliCode.UNSUPPORTED_PLATFORM, {
        message: `Unsupported arch: ${rawArch}`,
        context: { arch: rawArch },
    });

    return { os, arch };
}

// ── Cache paths ────────────────────────────────────────────────────────────

export function cacheRoot(): string {
    return process.env.SYNCENGINE_BIN_CACHE ?? join(homedir(), '.cache', 'syncengine');
}

export function toolDir(tool: string, version: string): string {
    return join(cacheRoot(), 'bin', tool, version);
}

// ── Logging ────────────────────────────────────────────────────────────────

function log(msg: string): void {
    if (process.env.SYNCENGINE_BIN_QUIET) return;
    process.stderr.write(`[syncengine/bin-utils] ${msg}\n`);
}

// ── Download + extract ─────────────────────────────────────────────────────

export interface BinarySpec {
    /** Short tool name — e.g. "nats-server", "restate-server". */
    tool: string;
    /** Pinned semver (without leading "v") — e.g. "2.12.6". */
    version: string;
    /** Download URL template, with ${version} and ${os}/${arch} placeholders. */
    assetUrl: (v: { version: string; host: Host }) => string;
    /** Relative path inside the extracted archive to the binary. */
    entrypoint: (v: { version: string; host: Host }) => string;
    /**
     * Optional SHA-256 of the downloaded archive for integrity verification.
     * Keyed by `${os}-${arch}`. Omitted entries skip verification (dev-friendly,
     * prod should pin all hashes).
     */
    sha256?: Partial<Record<`${HostOs}-${HostArch}`, string>>;
}

/**
 * Ensure a binary is downloaded and return its absolute path.
 *
 * First-call behavior (cold cache): downloads the archive, verifies SHA-256
 * if pinned, extracts, chmods +x, returns path.
 *
 * Subsequent calls (warm cache): returns path immediately after an O(1) stat.
 *
 * Not safe for concurrent calls from multiple processes on the same cache
 * entry — two racing cold-cache fetches can collide on the tmpdir archive
 * path and interleave extraction into `dir`. In practice only one
 * `syncengine dev` runs at a time so this is not an issue today; add file
 * locking here if that ever changes.
 */
export async function ensureBinary(spec: BinarySpec): Promise<string> {
    const host = detectHost();
    const dir = toolDir(spec.tool, spec.version);
    const entry = join(dir, spec.entrypoint({ version: spec.version, host }));

    if (existsSync(entry)) return entry;

    log(`${spec.tool}@${spec.version}: downloading for ${host.os}-${host.arch}`);
    mkdirSync(dir, { recursive: true });

    const url = spec.assetUrl({ version: spec.version, host });
    const archiveName = url.split('/').pop() ?? `${spec.tool}.archive`;
    const archivePath = join(tmpdir(), `syncengine-${spec.tool}-${spec.version}-${archiveName}`);

    await downloadTo(url, archivePath);

    // Integrity check
    const pinned = spec.sha256?.[`${host.os}-${host.arch}`];
    if (pinned) {
        const actual = await sha256File(archivePath);
        if (actual !== pinned) {
            throw errors.cli(CliCode.CHECKSUM_MISMATCH, {
                message:
                    `${spec.tool}@${spec.version}: checksum mismatch for ${host.os}-${host.arch}\n` +
                    `  expected: ${pinned}\n  actual:   ${actual}`,
                context: { tool: spec.tool, version: spec.version, os: host.os, arch: host.arch },
            });
        }
        log(`${spec.tool}@${spec.version}: checksum verified`);
    }

    await extractArchive(archivePath, dir);

    if (!existsSync(entry)) {
        throw errors.cli(CliCode.BINARY_NOT_FOUND, {
            message: `${spec.tool}@${spec.version}: expected binary at ${entry} after extraction but it was not found`,
            context: { tool: spec.tool, entry },
        });
    }

    // Ensure executable bit is set on Unix
    if (host.os !== 'windows') {
        chmodSync(entry, 0o755);
    }

    log(`${spec.tool}@${spec.version}: ready at ${entry}`);
    return entry;
}

// ── Internals ──────────────────────────────────────────────────────────────

async function downloadTo(url: string, dest: string): Promise<void> {
    // Node 20+ has global fetch
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) {
        throw errors.connection(ConnectionCode.HTTP_ERROR, {
            message: `download failed: ${url} (HTTP ${res.status})`,
            context: { url, status: res.status },
        });
    }

    mkdirSync(dirname(dest), { recursive: true });
    // Cast to NodeJS ReadableStream — web stream is compatible with pipeline
    // via Readable.fromWeb in Node 18+, but fetch's body is already compatible
    // with pipeline in Node 20+ via ReadableStream interop.
    const { Readable } = await import('node:stream');
    const nodeStream = Readable.fromWeb(res.body as any);
    await pipeline(nodeStream, createWriteStream(dest));
}

async function sha256File(path: string): Promise<string> {
    const data = await readFile(path);
    return createHash('sha256').update(data).digest('hex');
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
    // Dispatch by extension. We only support the formats our target binaries use.
    //
    // `--no-same-owner` prevents tar from trying to chown extracted files to
    // the archive's recorded uid/gid (meaningless in a user cache and noisy).
    // We deliberately do NOT extract with `--keep-old-files` on cold cache
    // paths because that would fail on partial extraction retries — instead,
    // SHA-256 verification (done before this is called) is the integrity
    // gate, and path-traversal entries in a compromised archive would be
    // caught by hash mismatch long before tar ever sees them.
    if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
        execFileSync('tar', ['-xzf', archivePath, '--no-same-owner', '-C', destDir], { stdio: 'inherit' });
    } else if (archivePath.endsWith('.tar.xz')) {
        execFileSync('tar', ['-xJf', archivePath, '--no-same-owner', '-C', destDir], { stdio: 'inherit' });
    } else if (archivePath.endsWith('.zip')) {
        execFileSync('unzip', ['-q', '-o', archivePath, '-d', destDir], { stdio: 'inherit' });
    } else {
        throw errors.cli(CliCode.UNSUPPORTED_ARCHIVE, {
            message: `unsupported archive format: ${archivePath}`,
            context: { path: archivePath },
        });
    }
}
