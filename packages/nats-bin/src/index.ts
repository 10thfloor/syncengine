/**
 * Lazy downloader for `nats-server`.
 *
 * Consumers call `binaryPath()` (async) to get the absolute path to a cached
 * nats-server binary for the host platform. On first call, the binary is
 * downloaded and extracted; subsequent calls are O(1) existence checks.
 *
 * No postinstall script — download happens on first use so CI that doesn't
 * actually need the binary isn't slowed down.
 */

import { ensureBinary, type BinarySpec } from '@syncengine/bin-utils';

const VERSION = '2.12.6';

// NATS releases use `darwin`/`linux`/`windows` for os and `amd64`/`arm64`
// for arch — the same names @syncengine/bin-utils already produces, so
// `host.os`/`host.arch` can be dropped straight into the URL.
//
// SHA-256 hashes pinned from the official SHA256SUMS release asset at
// https://github.com/nats-io/nats-server/releases/download/v2.12.6/SHA256SUMS
// Bumping VERSION requires re-fetching and updating every entry below.
const SPEC: BinarySpec = {
    tool: 'nats-server',
    version: VERSION,
    assetUrl: ({ version, host }) => {
        const ext = host.os === 'windows' ? 'zip' : 'tar.gz';
        return `https://github.com/nats-io/nats-server/releases/download/v${version}/nats-server-v${version}-${host.os}-${host.arch}.${ext}`;
    },
    entrypoint: ({ version, host }) => {
        const exe = host.os === 'windows' ? '.exe' : '';
        // Archive extracts to a directory named like the archive stem.
        return `nats-server-v${version}-${host.os}-${host.arch}/nats-server${exe}`;
    },
    sha256: {
        'darwin-amd64':  'd7bc326ebbaf0a032ae1b03b99e4d863d9320ad010f37a22b2e8306ab3272ca0',
        'darwin-arm64':  'b9b287b786e83e783702214d516042f6397f7c1c4916985c6ec5e6d9d490151c',
        'linux-amd64':   '77fe7dd69ff5144126026b78355900be0ab0bb4339dc61a7621dcc9b9e9d07a6',
        'linux-arm64':   'fddaf3f223c7af3f4d0a0d2c2fc084406e6b3ec7adfd1b9e6a37fbd03bfe222f',
        'windows-amd64': '35445ebdf3232eeafb866e5c3bca5ac3c189525423367997b81945e9b2ace45b',
        'windows-arm64': '2680336e43ce1e22f7e60736536732eacf0872c07e34af80f91344602637a97d',
    },
};

/**
 * Ensure the pinned NATS server binary is available and return its absolute
 * path. Idempotent — safe to call repeatedly from the same process; see
 * `ensureBinary` for the caveat on concurrent cross-process calls.
 */
export async function binaryPath(): Promise<string> {
    return ensureBinary(SPEC);
}

/** Pinned version this package downloads. */
export const natsServerVersion: string = VERSION;
