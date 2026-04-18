/**
 * `syncengine serve` — spawn the production HTTP server binary.
 *
 * Thin wrapper around `@syncengine/serve-bin`: resolves a Resolution
 * (compiled binary path or a monorepo source path) and dispatches on
 * its kind. The previous version folded the source case into a
 * `BUN::<path>` sentinel baked into the binary path string; this split
 * the decoding between the resolver and the spawner. The Resolution
 * union is the single source of truth now — resolver emits it, spawn
 * dispatches on it.
 */

import { spawn as spawnProcess } from 'node:child_process';
import { errors, CliCode, formatError, SyncEngineError } from '@syncengine/core';

export type RunResolution =
    | { readonly kind: 'binary'; readonly path: string }
    | { readonly kind: 'source'; readonly path: string };

export interface RunServeOptions {
    readonly resolve: () => Promise<RunResolution>;
    readonly spawn: (res: RunResolution, args: readonly string[]) => Promise<number>;
    readonly stderr?: (msg: string) => void;
}

/**
 * Test-friendly entry: pass in `resolve`, `spawn`, and optionally a
 * `stderr` writer. Returns the process exit code.
 */
export async function runServe(
    args: readonly string[],
    opts: RunServeOptions,
): Promise<number> {
    const stderr = opts.stderr ?? ((msg: string) => process.stderr.write(msg));

    let resolution: RunResolution;
    try {
        resolution = await opts.resolve();
    } catch (err) {
        const sErr = err instanceof SyncEngineError
            ? err
            : errors.cli(CliCode.BINARY_NOT_FOUND, {
                message: err instanceof Error ? err.message : String(err),
                cause: err instanceof Error ? err : new Error(String(err)),
            });
        stderr(formatError(sErr, { color: process.stderr.isTTY ?? false }) + '\n');
        return 1;
    }

    return opts.spawn(resolution, args);
}

/**
 * Production entry: uses the real serve-bin resolver and node's spawn.
 * The CLI dispatcher calls this.
 */
export async function serveCommand(args: readonly string[]): Promise<void> {
    const { resolveServe } = await import('@syncengine/serve-bin');
    const code = await runServe(args, {
        resolve: resolveServe,
        spawn: runBinary,
    });
    if (code !== 0) process.exit(code);
}

function runBinary(
    res: RunResolution,
    args: readonly string[],
): Promise<number> {
    const [cmd, cmdArgs] =
        res.kind === 'source'
            ? (['bun', ['run', res.path, ...args]] as const)
            : ([res.path, [...args]] as const);

    return new Promise((resolve, reject) => {
        const child = spawnProcess(cmd, cmdArgs as string[], { stdio: 'inherit' });

        // Forward termination signals so Kubernetes / systemd can drive
        // a graceful shutdown through the CLI to the binary.
        const forward = (sig: NodeJS.Signals) => () => {
            if (!child.killed) child.kill(sig);
        };
        const onTerm = forward('SIGTERM');
        const onInt = forward('SIGINT');
        process.on('SIGTERM', onTerm);
        process.on('SIGINT', onInt);

        child.on('exit', (code, signal) => {
            process.off('SIGTERM', onTerm);
            process.off('SIGINT', onInt);
            if (code !== null) resolve(code);
            else if (signal) resolve(128 + signalNumber(signal));
            else resolve(0);
        });
        child.on('error', reject);
    });
}

function signalNumber(signal: NodeJS.Signals): number {
    switch (signal) {
        case 'SIGINT': return 2;
        case 'SIGQUIT': return 3;
        case 'SIGTERM': return 15;
        default: return 0;
    }
}
