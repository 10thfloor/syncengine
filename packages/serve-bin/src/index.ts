/**
 * Lazy resolver for the syncengine-serve binary.
 *
 * Consumers call `binaryPath()` to get an absolute path to a usable
 * binary. In a monorepo checkout this path is populated by compiling
 * packages/serve with `bun build --compile` — subsequent calls return
 * the cached output. Outside the monorepo (after CI publishes releases)
 * the downloader fallback kicks in.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { errors, CliCode } from '@syncengine/core';
import { resolveBinaryPath, resolveForRun, findWorkspaceRoot } from './resolver';
import type { Resolution } from './resolver';

export { resolveBinaryPath, resolveForRun, findWorkspaceRoot };
export type { Resolution };

/**
 * Resolve how to run syncengine-serve. In the monorepo this is the
 * TypeScript source (run via `bun`); outside, it's a compiled binary.
 * The CLI dispatches on the returned `kind`.
 */
export async function resolveServe(): Promise<Resolution> {
    const cacheDir =
        process.env.SYNCENGINE_BIN_CACHE ??
        join(homedir(), '.cache', 'syncengine', 'bin', 'serve');
    const workspaceRoot = findWorkspaceRoot(process.cwd());
    return resolveForRun({
        cacheDir,
        workspaceRoot,
        compile: compileWithBun,
    });
}

/**
 * Backwards-compat binaryPath() — returns an executable path, forcing
 * a compile if necessary. Kept for parity with nats-bin / restate-bin.
 * Prefer resolveServe() for new code.
 */
export async function binaryPath(): Promise<string> {
    const cacheDir =
        process.env.SYNCENGINE_BIN_CACHE ??
        join(homedir(), '.cache', 'syncengine', 'bin', 'serve');
    const workspaceRoot = findWorkspaceRoot(process.cwd());
    return resolveBinaryPath({
        cacheDir,
        workspaceRoot,
        compile: compileWithBun,
    });
}

/** Actual `bun build --compile` invocation. Extracted so the resolver
 *  stays pure + testable. */
async function compileWithBun(args: {
    readonly source: string;
    readonly outPath: string;
}): Promise<string> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(
            'bun',
            [
                'build',
                '--compile',
                '--minify',
                '--sourcemap=none',
                `--outfile=${args.outPath}`,
                args.source,
            ],
            { stdio: 'inherit' },
        );
        child.on('exit', (code) => {
            if (code === 0) resolvePromise();
            else rejectPromise(
                errors.cli(CliCode.BINARY_NOT_FOUND, {
                    message: `bun build --compile exited with code ${code}`,
                    hint: `Is bun installed? (https://bun.sh/install)`,
                    context: { source: args.source, outPath: args.outPath },
                }),
            );
        });
        child.on('error', (err) => {
            rejectPromise(
                errors.cli(CliCode.BINARY_NOT_FOUND, {
                    message: `failed to spawn \`bun build\`: ${err.message}`,
                    hint: `Is bun on your PATH? Install at https://bun.sh`,
                    cause: err,
                }),
            );
        });
    });
    return args.outPath;
}
