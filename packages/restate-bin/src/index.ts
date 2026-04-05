/**
 * Lazy downloader for `restate-server`.
 *
 * Pinned to v1.4.4 — the last release that ships prebuilt binaries as
 * GitHub release assets. Newer releases (v1.5+) ship source-only, so
 * upgrading will require either Docker, `cargo install`, or waiting for
 * Restate to restore binary releases. For Phase 1 we pin to a version
 * that Just Works.
 *
 * Consumers call `binaryPath()` (async) to get the absolute path to a cached
 * restate-server binary for the host platform. On first call, the binary is
 * downloaded and extracted; subsequent calls are O(1) existence checks.
 */

import { ensureBinary, type BinarySpec, type Host } from '@syncengine/bin-utils';

const VERSION = '1.4.4';

// SHA-256 hashes pinned from the per-asset .sha256 files published at
// https://github.com/restatedev/restate/releases/tag/v1.4.4
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
        'darwin-arm64': '9afa1f6359aa44c1f2d439a05a007f4220ebe5d432eceaa75a9595d43ab061fc',
        'darwin-amd64': 'cd09421ec30cc850258c5a4a77184584de0fb88090b394f9f97515dc2ceb758f',
        'linux-arm64':  '8a6e687d4ac976088cd23ec1c9636e14af45107025ca1137e919db7e2d4fd74a',
        'linux-amd64':  '1835fed2e5d572016e535145a6af1312d4ad52a36b04cfc9e68e50ef933f608c',
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
