/**
 * `syncengine down` — terminate a running dev stack.
 *
 * Reads `.syncengine/dev/pids.json`, SIGTERMs each child and the
 * orchestrator itself, waits briefly, then SIGKILLs anything still alive.
 * Unlinks both state files at the end.
 *
 * Used when a previous `syncengine dev` was force-killed and left
 * orphaned processes (e.g. terminal closed without Ctrl-C).
 */

import { banner, note } from './runner';
import {
    findAppRoot,
    stateDirFor,
    readPids,
    isAlive,
    clearStateFiles,
    type Pids,
} from './state';

const SHUTDOWN_TIMEOUT_MS = 4000;
const CHILD_ORDER: Array<keyof NonNullable<Pids['children']>> = ['vite', 'workspace', 'restate', 'nats'];

export async function downCommand(_args: string[]): Promise<void> {
    const repoRoot = await findAppRoot();
    const stateDir = stateDirFor(repoRoot);
    const pids = readPids(stateDir);

    if (!pids) {
        process.stdout.write('No recorded syncengine dev stack (no pids.json).\n');
        return;
    }

    const targets = collectTargets(pids);
    const live = targets.filter((t) => isAlive(t.pid));

    if (live.length === 0) {
        note('pids.json references no live processes (stale file)');
        clearStateFiles(stateDir);
        process.stdout.write('State files cleared.\n');
        return;
    }

    banner(`stopping ${live.length} process${live.length === 1 ? '' : 'es'}`);
    for (const { name, pid } of live) {
        note(`sending SIGTERM to ${name} (pid ${pid})`);
        tryKill(pid, 'SIGTERM');
    }

    // Give them a chance to shut down gracefully
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (live.every((t) => !isAlive(t.pid))) break;
        await sleep(100);
    }

    // Anything still alive gets force-killed
    const stubborn = live.filter((t) => isAlive(t.pid));
    if (stubborn.length > 0) {
        for (const { name, pid } of stubborn) {
            process.stderr.write(`  force-killing ${name} (pid ${pid})\n`);
            tryKill(pid, 'SIGKILL');
        }
    }

    clearStateFiles(stateDir);
    process.stdout.write('\x1b[1;32m✓ stopped.\x1b[0m\n');
}

// ── Internals ─────────────────────────────────────────────────────────────

interface Target {
    name: string;
    pid: number;
}

function collectTargets(pids: Pids): Target[] {
    const targets: Target[] = [];

    // Children first, in reverse-dependency order (vite → nats)
    for (const name of CHILD_ORDER) {
        const pid = pids.children[name];
        if (pid) targets.push({ name, pid });
    }

    // Orchestrator last — stopping it before children may leave grandchildren
    // unparented depending on signal delivery order.
    if (pids.orchestrator) {
        targets.push({ name: 'orchestrator', pid: pids.orchestrator });
    }

    return targets;
}

function tryKill(pid: number, signal: NodeJS.Signals): void {
    // Kill the process group (negative pid) when possible — the orchestrator
    // spawned each child with `detached: true`, so pgid === pid.
    if (process.platform !== 'win32') {
        try { process.kill(-pid, signal); return; } catch { /* fall through */ }
    }
    try { process.kill(pid, signal); } catch { /* ignore */ }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
