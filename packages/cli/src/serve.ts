/**
 * `syncengine serve` — spawn the production HTTP server binary.
 *
 * Thin wrapper around `@syncengine/serve-bin`: resolves a binary path
 * (from cache, local compile, or future release download) and spawns
 * it with the user's args. The binary itself does the real work; this
 * command is just plumbing.
 */

import { spawn as spawnProcess } from 'node:child_process';
import { errors, CliCode, formatError, SyncEngineError } from '@syncengine/core';

export interface RunServeOptions {
    readonly resolveBinary: () => Promise<string>;
    readonly spawn: (binary: string, args: readonly string[]) => Promise<number>;
    readonly stderr?: (msg: string) => void;
}

/**
 * Test-friendly entry: pass in `resolveBinary`, `spawn`, and optionally
 * a `stderr` writer. Returns the process exit code.
 */
export async function runServe(
    args: readonly string[],
    opts: RunServeOptions,
): Promise<number> {
    const stderr = opts.stderr ?? ((msg: string) => process.stderr.write(msg));

    let binary: string;
    try {
        binary = await opts.resolveBinary();
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

    return opts.spawn(binary, args);
}

/**
 * Production entry: uses the real serve-bin resolver and node's spawn.
 * The CLI dispatcher calls this.
 */
export async function serveCommand(args: readonly string[]): Promise<void> {
    const { resolveServe } = await import('@syncengine/serve-bin');
    const code = await runServe(args, {
        resolveBinary: async () => {
            const resolution = await resolveServe();
            // The runServe contract is "spawn this as a binary." For a
            // source Resolution, we hand back a bun-wrapper path and
            // prepend the source path in the spawn. Easiest way: format
            // a sentinel string the spawn step recognizes.
            return resolution.kind === 'source'
                ? `BUN::${resolution.path}`
                : resolution.path;
        },
        spawn: runBinary,
    });
    if (code !== 0) process.exit(code);
}

function runBinary(binaryOrSentinel: string, args: readonly string[]): Promise<number> {
    // Source-run path: invoke bun directly with the TS entrypoint.
    const [cmd, cmdArgs] = binaryOrSentinel.startsWith('BUN::')
        ? (['bun', ['run', binaryOrSentinel.slice(5), ...args]] as const)
        : ([binaryOrSentinel, [...args]] as const);

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
