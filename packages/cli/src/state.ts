/**
 * Dev state directory helpers.
 *
 * Everything lives under `.syncengine/dev/` (relative to the repo root, or
 * overridden via SYNCENGINE_STATE_DIR). Two small JSON files track runtime
 * state so `down`, `status`, and the `workspace` subcommands can find an
 * already-running orchestrator:
 *
 *   ports.json  — which ports the running stack is bound to
 *   pids.json   — orchestrator pid + each child pid for graceful shutdown
 *
 * Both are written by `dev` on startup and unlinked on shutdown. If the
 * orchestrator crashes, the files may be stale — readers check pid
 * liveness before trusting them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Ports ─────────────────────────────────────────────────────────────────

export interface Ports {
    natsClient: number;
    natsWs: number;
    natsMonitor: number;
    restateIngress: number;
    restateAdmin: number;
    restateNode: number;
    gateway: number;
    workspace: number;
    vite: number;
}

export const DEFAULT_PORTS: Ports = {
    natsClient: 4222,
    natsWs: 9222,
    natsMonitor: 8222,
    restateIngress: 8080,
    restateAdmin: 9070,
    restateNode: 5122,
    gateway: 9333,
    workspace: 9080,
    vite: 5173,
};

// ── Pids ──────────────────────────────────────────────────────────────────

export interface Pids {
    /** The `syncengine dev` process itself (the one running dev.ts). */
    orchestrator: number;
    /** Start timestamp, useful for stale-file detection. */
    startedAt: number;
    children: Partial<Record<'nats' | 'restate' | 'gateway' | 'workspace' | 'vite', number>>;
}

// ── Runtime config (consumed by @syncengine/vite-plugin) ─────────────────

/**
 * Framework-facing runtime configuration. Written by `syncengine dev`
 * after the stack is ready, consumed by `@syncengine/vite-plugin` to
 * populate `virtual:syncengine/runtime-config`. User code never sees
 * these values directly — the client runtime reads them via the virtual
 * module.
 */
export interface RuntimeConfig {
    /**
     * Optional fallback workspace id. Only consumed by
     * `@syncengine/vite-plugin` when running outside a browser context
     * (SSR, vitest, node scripts) — in a browser, the plugin injects
     * the real wsKey via `<meta name="syncengine-workspace-id">` on
     * every page load based on the user's `syncengine.config.ts`
     * resolver. As of PLAN Phase 8 the CLI no longer writes this
     * field because there is no single pinned workspace.
     */
    workspaceId?: string;
    /** WebSocket URL the browser connects to for NATS + JetStream. */
    natsUrl: string;
    /** HTTP URL of the syncengine gateway (Phase 10). */
    gatewayUrl?: string;
    /** Restate ingress HTTP URL for authority / workspace RPC. */
    restateUrl: string;
    /** Optional JWT for authenticated dev sessions (null in open dev). */
    authToken: string | null;
}

// ── Paths ─────────────────────────────────────────────────────────────────

export async function findRepoRoot(): Promise<string> {
    let dir = process.cwd();
    while (true) {
        if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // Fallback: walk up from this source file to the repo root
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..', '..');
}

export function stateDirFor(repoRoot: string): string {
    return resolve(
        process.env.SYNCENGINE_STATE_DIR ?? join(repoRoot, '.syncengine', 'dev'),
    );
}

function portsFilePath(stateDir: string): string {
    return join(stateDir, 'ports.json');
}

function pidsFilePath(stateDir: string): string {
    return join(stateDir, 'pids.json');
}

function runtimeConfigPath(stateDir: string): string {
    return join(stateDir, 'runtime.json');
}

// ── Read/write ────────────────────────────────────────────────────────────

export function writePorts(stateDir: string, ports: Ports): void {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(portsFilePath(stateDir), JSON.stringify(ports, null, 2));
}

export function readPorts(stateDir: string): Ports | null {
    const path = portsFilePath(stateDir);
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Ports;
        return parsed;
    } catch {
        return null;
    }
}

/** Returns recorded ports if present, otherwise the static defaults. */
export function readPortsOrDefaults(stateDir: string): Ports {
    return readPorts(stateDir) ?? DEFAULT_PORTS;
}

export function writePids(stateDir: string, pids: Pids): void {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(pidsFilePath(stateDir), JSON.stringify(pids, null, 2));
}

export function readPids(stateDir: string): Pids | null {
    const path = pidsFilePath(stateDir);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Pids;
    } catch {
        return null;
    }
}

export function writeRuntimeConfig(stateDir: string, config: RuntimeConfig): void {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(runtimeConfigPath(stateDir), JSON.stringify(config, null, 2));
}

export function clearStateFiles(stateDir: string): void {
    for (const path of [
        portsFilePath(stateDir),
        pidsFilePath(stateDir),
        runtimeConfigPath(stateDir),
    ]) {
        try { unlinkSync(path); } catch { /* ignore */ }
    }
}

// ── Process liveness ──────────────────────────────────────────────────────

/**
 * Returns `true` if a process with this pid currently exists.
 *
 * Known limitation: this cannot distinguish a recycled pid from the
 * original process. If the orchestrator crashes and the OS later assigns
 * its pid to an unrelated process, `isAlive` will report it as live and
 * `syncengine down` will send SIGTERM to the wrong process. The recorded
 * `pids.startedAt` timestamp could be cross-checked against the OS-level
 * process start time to eliminate this, but doing so is platform-specific
 * (`/proc/<pid>/stat` on Linux, `sysctl kern.proc.pid` on macOS) and not
 * currently implemented. In practice pid recycling is rare enough during
 * a single dev session that the risk is acceptable for a local tool.
 */
export function isAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
        // Signal 0 is a permission/existence probe; doesn't actually send.
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // ESRCH = no such process; EPERM = exists but we can't signal it
        const code = (err as NodeJS.ErrnoException).code;
        return code === 'EPERM';
    }
}
