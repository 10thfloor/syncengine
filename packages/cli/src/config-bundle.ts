/**
 * Second esbuild pass that produces `dist/server/config.mjs` — the
 * isolated ESM module the serve binary dynamic-imports to pick up the
 * user's `workspaces.resolve()` and `auth.verify()` callbacks.
 *
 * Lives separately from `dist/server/index.mjs` (the Restate endpoint)
 * for two reasons:
 *
 *   1. The Restate endpoint bundle pulls in ~4 MB of server runtime
 *      (NATS, Restate SDK, entity registry). The HTML server only
 *      needs the config — a fraction of the cost to load.
 *
 *   2. We run a build-time guard (the nativeImportGuard plugin below)
 *      that fails the build if the user imports native `.node` modules
 *      from `syncengine.config.ts`. `bun build --compile` can't ship
 *      those alongside the single-file binary, so rejecting them at
 *      build time beats a confusing runtime error. Plugin is only
 *      wireable through esbuild's programmatic API — hence this file
 *      dropping the CLI-args abstraction from v1.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { build as esbuild, type Plugin } from 'esbuild';
import { errors, CliCode } from '@syncengine/core';

const STUB_CONTENT = `// Emitted by \`syncengine build\` when no syncengine.config.ts exists.
// Edit syncengine.config.ts in your app root to customize workspace
// resolution and auth.
export default {
  workspaces: {
    resolve: () => 'default',
  },
};
`;

export interface ConfigBundleInput {
    /** Absolute path to the user's syncengine.config.ts, or null to emit a stub. */
    readonly configPath: string | null;
    /** Absolute path to <appDir>/dist. */
    readonly distDir: string;
    /** Absolute path to the app root. */
    readonly appDir: string;
}

export interface ConfigBundleResult {
    readonly kind: 'esbuild' | 'stub';
    readonly outPath: string;
}

export async function buildConfigBundle(
    input: ConfigBundleInput,
): Promise<ConfigBundleResult> {
    const outPath = join(input.distDir, 'server', 'config.mjs');
    mkdirSync(dirname(outPath), { recursive: true });

    if (!input.configPath) {
        writeFileSync(outPath, STUB_CONTENT);
        return { kind: 'stub', outPath };
    }

    await esbuild({
        entryPoints: [input.configPath],
        outfile: outPath,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        absWorkingDir: input.appDir,
        plugins: [nativeImportGuard()],
        // Surface the specific file that failed, not a stack trace.
        logLevel: 'silent',
    });

    return { kind: 'esbuild', outPath };
}

// ── Plugin: reject native module imports ──────────────────────────────────
//
// `syncengine.config.ts` runs inside `syncengine serve` — a single-file
// Bun-compiled binary. Native `.node` modules can't ship inside that
// binary. Catching them at build time beats a confusing "module not
// found at runtime" ~weeks after deploy.
//
// Pure-JS alternatives:
//   bcrypt       → argon2-browser, bcryptjs, or @node-rs/bcrypt in a sidecar
//   jsonwebtoken → jose
//   sqlite3      → @libsql/client or better-sqlite3 in a sidecar
//   sharp        → run image processing in a separate worker/service

function nativeImportGuard(): Plugin {
    return {
        name: 'syncengine:native-import-guard',
        setup(build) {
            // Any `.node` file hit during resolution is fatal.
            build.onResolve({ filter: /\.node$/ }, (args) => {
                throw errors.cli(CliCode.NATIVE_IMPORT_REJECTED, {
                    message:
                        `syncengine.config.ts imports a native module (${args.path}) — ` +
                        `native .node files can't be bundled into the single-file ` +
                        `serve binary.`,
                    hint:
                        `Replace with a pure-JS alternative (jose instead of ` +
                        `jsonwebtoken-native; argon2-browser or bcryptjs instead ` +
                        `of bcrypt). The offending import came from: ${args.importer}`,
                    context: { nativeModule: args.path, importer: args.importer },
                });
            });
        },
    };
}
