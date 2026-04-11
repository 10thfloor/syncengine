/**
 * Small child-process runner with prefixed log streaming and process-group
 * shutdown. Enough to orchestrate 4 long-running processes without pulling
 * in a dependency like concurrently or execa.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { errors, CliCode } from '@syncengine/core';

// ── ANSI colors for log prefixes ──────────────────────────────────────────

const COLORS: Record<string, string> = {
    nats: '\x1b[36m',        // cyan
    restate: '\x1b[35m',     // magenta
    workspace: '\x1b[33m',   // yellow
    vite: '\x1b[32m',        // green
    syncengine: '\x1b[1;34m', // bold blue
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function color(name: string): string {
    return COLORS[name] ?? '\x1b[37m';
}

// ── Logging ────────────────────────────────────────────────────────────────

/** Banner line printed by the CLI itself, always visible. */
export function banner(msg: string): void {
    process.stdout.write(`${color('syncengine')}▸${RESET} ${msg}\n`);
}

/** Prefix every line of `stream` with [name] in the process's color. */
function streamLines(name: string, stream: Readable | null): void {
    if (!stream) return;
    const prefix = `${color(name)}[${name}]${RESET}`;
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
        if (!line) return;
        process.stdout.write(`${prefix} ${line}\n`);
    });
}

/** Write a note to stdout about an internal CLI action (muted). */
export function note(msg: string): void {
    process.stdout.write(`${DIM}  ${msg}${RESET}\n`);
}

// ── Spawning ──────────────────────────────────────────────────────────────

export interface ManagedProcess {
    name: string;
    child: ChildProcess;
}

export interface SpawnManagedOptions extends SpawnOptions {
    /** Logical name for log prefixing and shutdown ordering. */
    name: string;
}

/**
 * Spawn a child in a new process group (unix) so we can kill its entire
 * subtree later via `process.kill(-pid, signal)`. stdout + stderr are piped
 * through `streamLines` with a colored prefix.
 */
export function spawnManaged(
    command: string,
    args: string[],
    opts: SpawnManagedOptions,
): ManagedProcess {
    const { name, ...spawnOpts } = opts;

    const child = spawn(command, args, {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...spawnOpts,
    });

    streamLines(name, child.stdout);
    streamLines(name, child.stderr);

    child.on('exit', (code, signal) => {
        if (code !== null && code !== 0) {
            process.stderr.write(
                `${color(name)}[${name}]${RESET} ${DIM}exited with code ${code}${RESET}\n`,
            );
        } else if (signal) {
            process.stderr.write(
                `${color(name)}[${name}]${RESET} ${DIM}terminated (${signal})${RESET}\n`,
            );
        }
    });

    return { name, child };
}

// ── Shutdown ──────────────────────────────────────────────────────────────

/** Handle returned by `registerShutdown`. */
export interface ShutdownHandle {
    /**
     * Trigger graceful termination from code (e.g. an error handler).
     * Idempotent — concurrent calls collapse onto the first in-flight run.
     */
    shutdown: (reason: string) => Promise<void>;
    /**
     * `true` once any signal handler or explicit `shutdown()` call has begun.
     * Used by error paths to avoid calling `process.exit` after a signal
     * handler has already claimed control of the exit code.
     */
    isShuttingDown: () => boolean;
}

/**
 * Register SIGINT/SIGTERM handlers that cleanly terminate all managed
 * children in reverse order. Returns a handle whose `shutdown` function
 * can also be called directly (e.g. from an error handler) to clean up
 * without relying on signal delivery.
 *
 * Second Ctrl-C force-kills immediately. All `shutdown()` invocations
 * share a single in-flight promise so the teardown cannot run twice
 * concurrently — the second call awaits the first's completion.
 */
export function registerShutdown(
    processes: ManagedProcess[],
    {
        timeoutMs = 4000,
        onDone,
    }: {
        timeoutMs?: number;
        /** Called once after all children have exited, before process.exit. */
        onDone?: () => void | Promise<void>;
    } = {},
): ShutdownHandle {
    let shuttingDown = false;
    let currentShutdown: Promise<void> | null = null;
    let forceKillRequested = false;

    async function runShutdown(reason: string): Promise<void> {
        banner(`shutting down (${reason})`);

        // Terminate in reverse order so dependents go first
        const reversed = [...processes].reverse();
        for (const { name, child } of reversed) {
            if (!child.pid || child.exitCode !== null) continue;
            note(`stopping ${name}…`);
            try { killGroup(child, 'SIGTERM'); } catch { /* ignore */ }
        }

        // Wait up to timeoutMs for all children to exit, then SIGKILL.
        // A concurrent "force kill" trigger (second Ctrl-C) breaks the wait
        // early.
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && !forceKillRequested) {
            const alive = processes.some((p) => p.child.exitCode === null && p.child.signalCode === null);
            if (!alive) break;
            await sleep(100);
        }

        for (const { child } of reversed) {
            if (child.exitCode === null && child.signalCode === null && child.pid) {
                try { killGroup(child, 'SIGKILL'); } catch { /* ignore */ }
            }
        }

        if (onDone) {
            try { await onDone(); } catch { /* ignore */ }
        }
    }

    async function shutdown(reason: string): Promise<void> {
        if (currentShutdown) {
            // Second invocation while shutdown is in flight: upgrade to
            // force-kill and let the caller await the same promise.
            if (!forceKillRequested) {
                forceKillRequested = true;
                process.stderr.write('\nforce-killing remaining processes...\n');
                for (const { child } of processes) {
                    if (child.pid) {
                        try { killGroup(child, 'SIGKILL'); } catch { /* ignore */ }
                    }
                }
            }
            return currentShutdown;
        }
        shuttingDown = true;
        currentShutdown = runShutdown(reason);
        return currentShutdown;
    }

    process.on('SIGINT', () => {
        shutdown('SIGINT').finally(() => process.exit(130));
    });
    process.on('SIGTERM', () => {
        shutdown('SIGTERM').finally(() => process.exit(143));
    });

    return {
        shutdown,
        isShuttingDown: () => shuttingDown,
    };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    if (process.platform === 'win32') {
        // Windows has no process groups; kill just this pid
        child.kill(signal);
        return;
    }
    // Kill the whole process group: pgid === child.pid because detached: true
    process.kill(-child.pid, signal);
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ── Health checks ─────────────────────────────────────────────────────────

/**
 * Poll a URL until it returns a 2xx, or `timeoutMs` elapses.
 * Used to gate orchestration on "process is actually ready".
 */
export async function waitForHttp(
    url: string,
    { timeoutMs = 30_000, intervalMs = 200, label }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
            lastErr = new Error(`HTTP ${res.status}`);
        } catch (err) {
            lastErr = err;
        }
        await sleep(intervalMs);
    }
    const tag = label ? ` (${label})` : '';
    throw errors.cli(CliCode.TIMEOUT, {
        message: `timed out waiting for ${url}${tag}: ${String(lastErr)}`,
        context: { url },
    });
}

/**
 * IPv4 and IPv6 loopback addresses. We always try both because targets like
 * Vite bind to `127.0.0.1` on Linux but to `::1` on newer macOS.
 */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

/**
 * Try a single TCP connection to `host:port`, resolving to `true` on a
 * successful connect and `false` on error or timeout. Shared core of
 * `waitForTcp` (readiness polling) and `canConnect` (one-shot probe).
 */
async function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
    const net = await import('node:net');
    return new Promise<boolean>((resolve) => {
        const socket = net.connect({ port, host });
        let settled = false;
        const timer = setTimeout(() => done(false), timeoutMs);
        const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(ok);
        };
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/**
 * Poll a TCP port until something accepts a connection, or `timeoutMs`
 * elapses. Tries every host in `hosts` on each iteration.
 */
export async function waitForTcp(
    port: number,
    {
        hosts = LOOPBACK_HOSTS,
        timeoutMs = 30_000,
        intervalMs = 200,
        label,
    }: {
        hosts?: string[]; timeoutMs?: number; intervalMs?: number; label?: string;
    } = {},
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const host of hosts) {
            if (await probeTcp(host, port, intervalMs)) return;
        }
        await sleep(intervalMs);
    }
    const tag = label ? ` (${label})` : '';
    throw errors.cli(CliCode.TIMEOUT, {
        message: `timed out waiting for tcp :${port}${tag} on [${hosts.join(', ')}]`,
        context: { port, hosts },
    });
}

// ── Preflight port checks ─────────────────────────────────────────────────

/**
 * Returns `true` if anything accepts a TCP connection on `port` within
 * `timeoutMs`. Tries both IPv4 and IPv6 loopback. Use this for readiness
 * probes where a bind-based check would be misled by dual-stack binds
 * (e.g. Vite bound to ::1 while we try to bind 0.0.0.0).
 */
export async function canConnect(
    port: number,
    { hosts = LOOPBACK_HOSTS, timeoutMs = 500 }: { hosts?: string[]; timeoutMs?: number } = {},
): Promise<boolean> {
    for (const host of hosts) {
        if (await probeTcp(host, port, timeoutMs)) return true;
    }
    return false;
}

/**
 * Check whether a TCP port is currently bindable. Returns `true` if we can
 * bind it (i.e. it's free), `false` if something else holds it. This is the
 * same technique `detect-port` uses — more reliable than parsing `lsof`.
 */
export async function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
    const net = await import('node:net');
    return new Promise<boolean>((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once('error', () => resolve(false));
        server.once('listening', () => server.close(() => resolve(true)));
        try {
            server.listen(port, host);
        } catch {
            resolve(false);
        }
    });
}

/**
 * Assert that every required port is free. If any are taken, print a
 * clear diagnostic (including the `lsof` owners if available) and throw.
 */
export async function requirePortsFree(
    ports: Array<{ port: number; label: string }>,
): Promise<void> {
    const taken: Array<{ port: number; label: string }> = [];
    for (const p of ports) {
        if (!(await isPortFree(p.port))) taken.push(p);
    }
    if (taken.length === 0) return;

    process.stderr.write('\n\x1b[1;31mPort conflict — cannot start:\x1b[0m\n');
    for (const { port, label } of taken) {
        const owner = await describePortOwner(port);
        process.stderr.write(`  • :${port}  (${label})${owner ? `  — held by ${owner}` : ''}\n`);
    }
    process.stderr.write(`
Hint: if these were started by docker compose earlier, stop them with:
  docker stop $(docker ps -q --filter name=dbsp-)
Or if they were started by a previous \`syncengine dev\` that crashed:
  pkill -f "syncengine dev" ; pkill -f "nats-server" ; pkill -f "restate-server"
\n`);
    throw errors.cli(CliCode.PORT_CONFLICT, {
        message: `${taken.length} port${taken.length === 1 ? '' : 's'} already in use`,
        hint: `Free the ports or let syncengine pick random ones.`,
        context: { ports: taken },
    });
}

async function describePortOwner(port: number): Promise<string | null> {
    try {
        const { execFileSync } = await import('node:child_process');
        const out = execFileSync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-n', '-P'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const lines = out.trim().split('\n');
        if (lines.length < 2) return null;
        // Lines are like: "COMMAND   PID USER   FD   TYPE ..."
        const parts = lines[1].split(/\s+/);
        return `${parts[0]} (pid ${parts[1]})`;
    } catch {
        return null;
    }
}
