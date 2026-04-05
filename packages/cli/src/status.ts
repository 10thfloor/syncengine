/**
 * `syncengine status` — report on the running dev stack.
 *
 * Probes each expected service on its recorded (or default) port and
 * prints a compact table of health states. Fast (all probes in parallel),
 * no hang on unreachable services (each has a 2s timeout).
 */

import { canConnect } from './runner';
import {
    findRepoRoot,
    stateDirFor,
    readPorts,
    readPids,
    isAlive,
    DEFAULT_PORTS,
    type Ports,
} from './state';
import { restateHealth, natsJetstreamInfo } from './client';

type Health = 'up' | 'down' | 'unknown';

interface ServiceReport {
    name: string;
    port: number;
    url: string;
    health: Health;
    detail?: string;
}

export async function statusCommand(_args: string[]): Promise<void> {
    const repoRoot = await findRepoRoot();
    const stateDir = stateDirFor(repoRoot);

    const recordedPorts = readPorts(stateDir);
    const ports: Ports = recordedPorts ?? DEFAULT_PORTS;
    const pids = readPids(stateDir);

    // Header
    process.stdout.write('\n\x1b[1msyncengine status\x1b[0m\n');
    if (recordedPorts) {
        process.stdout.write(`  state dir: ${stateDir}\n`);
    } else {
        process.stdout.write(`  \x1b[2mno state dir — using default ports\x1b[0m\n`);
    }
    process.stdout.write('\n');

    // Orchestrator pid
    process.stdout.write(formatOrchestratorLine(pids));

    // Service probes in parallel
    const reports = await Promise.all([
        probeNats(ports),
        probeRestate(ports),
        probeWorkspace(ports),
        probeVite(ports),
    ]);

    // Compact table
    const nameWidth = Math.max(...reports.map((r) => r.name.length));
    for (const r of reports) {
        const { dot, label } = healthDisplay(r.health);
        const detail = r.detail ? `  \x1b[2m${r.detail}\x1b[0m` : '';
        process.stdout.write(
            `  ${r.name.padEnd(nameWidth)}  ${dot} ${label}  ${r.url}${detail}\n`,
        );
    }

    process.stdout.write('\n');
}

function formatOrchestratorLine(pids: ReturnType<typeof readPids>): string {
    if (!pids) {
        return `  orchestrator  \x1b[2m● not tracked\x1b[0m\n\n`;
    }
    if (!isAlive(pids.orchestrator)) {
        return `  orchestrator  \x1b[31m●\x1b[0m dead     (stale pids.json — run \`syncengine down\` to clean up)\n\n`;
    }
    const ageSeconds = Math.max(1, Math.round((Date.now() - pids.startedAt) / 1000));
    return `  orchestrator  \x1b[32m●\x1b[0m running  (pid ${pids.orchestrator}, up ${formatAge(ageSeconds)})\n\n`;
}

function healthDisplay(health: Health): { dot: string; label: string } {
    switch (health) {
        case 'up':      return { dot: '\x1b[32m●\x1b[0m', label: 'up      ' };
        case 'down':    return { dot: '\x1b[31m●\x1b[0m', label: 'down    ' };
        case 'unknown': return { dot: '\x1b[33m●\x1b[0m', label: 'unknown ' };
    }
}

// ── Service probes ───────────────────────────────────────────────────────

async function probeNats(ports: Ports): Promise<ServiceReport> {
    // /jsz doubles as a liveness check — if it responds, nats is up and
    // JetStream (which we always enable in our generated config) is ready.
    const url = `http://localhost:${ports.natsMonitor}/jsz`;
    const js = await natsJetstreamInfo(ports);
    if (!js) {
        return { name: 'nats', port: ports.natsMonitor, url, health: 'down' };
    }
    return {
        name: 'nats',
        port: ports.natsMonitor,
        url,
        health: 'up',
        detail: `${js.streams} streams, ${js.messages} msgs`,
    };
}

async function probeRestate(ports: Ports): Promise<ServiceReport> {
    const url = `http://localhost:${ports.restateAdmin}/health`;
    const ok = await restateHealth(ports);
    return {
        name: 'restate',
        port: ports.restateAdmin,
        url,
        health: ok ? 'up' : 'down',
    };
}

async function probeWorkspace(ports: Ports): Promise<ServiceReport> {
    // Workspace service speaks h2c so we can't use fetch — a TCP connect
    // is the reliable proxy.
    const up = await canConnect(ports.workspace);
    return {
        name: 'workspace',
        port: ports.workspace,
        url: `http://localhost:${ports.workspace}`,
        health: up ? 'up' : 'down',
    };
}

async function probeVite(ports: Ports): Promise<ServiceReport> {
    const url = `http://localhost:${ports.vite}/`;
    // Vite binds to localhost (which can be ::1 on macOS) so we try both.
    const up = await canConnect(ports.vite);
    return {
        name: 'vite',
        port: ports.vite,
        url,
        health: up ? 'up' : 'down',
    };
}

// ── Formatting ────────────────────────────────────────────────────────────

function formatAge(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h`;
}
