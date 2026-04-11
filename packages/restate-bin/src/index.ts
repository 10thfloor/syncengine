/**
 * Lazy downloader for `restate-server`.
 *
 * Consumers call `binaryPath()` (async) to get the absolute path to a cached
 * restate-server binary for the host platform. On first call, the binary is
 * downloaded and extracted; subsequent calls are O(1) existence checks.
 */

import { ensureBinary, type BinarySpec, type Host } from '@syncengine/bin-utils';

const VERSION = '1.6.2';

// SHA-256 hashes pinned from the per-asset .sha256 files published at
// https://github.com/restatedev/restate/releases/tag/v1.6.2
// Bumping VERSION requires re-fetching and updating every entry below.
// Windows is not supported — Restate doesn't publish a Windows binary.
const SPEC: BinarySpec = {
    tool: 'restate-server',
    version: VERSION,
    assetUrl: ({ version, host }) => {
        const triple = rustTargetTriple(host);
        return `https://github.com/restatedev/restate/releases/download/v${version}/restate-server-${triple}.tar.xz`;
    },
    entrypoint: ({ host }) => {
        const triple = rustTargetTriple(host);
        const exe = host.os === 'windows' ? '.exe' : '';
        // Archive extracts into a directory named after the target triple;
        // the binary lives inside that directory alongside LICENSE/README.
        return `restate-server-${triple}/restate-server${exe}`;
    },
    sha256: {
        'darwin-arm64': '126b4b03cf37cb5998c69ca94386ad321806124eb9b764b3b8a336303c30ef61',
        'darwin-amd64': '44c9c93ecbe7c0fb11f1e550d99c49644d5f9ac92c3ef5cc979661eb75372ed5',
        'linux-arm64':  'c35d548b3ebec13a3183c6acbbddc1c3656a1f26423d7d13af141773a09c6cf1',
        'linux-amd64':  '0d022e8beefe4e61dda735450848395ac60e581add37ead023d8f813d3712be1',
    },
};

function rustTargetTriple(host: Host): string {
    // Restate releases use Rust target triples:
    //   aarch64-apple-darwin
    //   x86_64-apple-darwin
    //   aarch64-unknown-linux-musl
    //   x86_64-unknown-linux-musl
    // Windows is not published as a prebuilt binary for restate-server.
    if (host.os === 'darwin') {
        return host.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    }
    if (host.os === 'linux') {
        return host.arch === 'arm64'
            ? 'aarch64-unknown-linux-musl'
            : 'x86_64-unknown-linux-musl';
    }
    throw new Error(
        `restate-server prebuilt binary not available for ${host.os}-${host.arch}. ` +
        `Supported: darwin-arm64, darwin-amd64, linux-arm64, linux-amd64.`,
    );
}

/**
 * Ensure the pinned Restate server binary is available and return its
 * absolute path. Idempotent — safe to call repeatedly from the same
 * process; see `ensureBinary` for the caveat on concurrent cross-process
 * calls.
 */
export async function binaryPath(): Promise<string> {
    return ensureBinary(SPEC);
}

/** Pinned version this package downloads. */
export const restateServerVersion: string = VERSION;
