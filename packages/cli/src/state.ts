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
import { join, resolve } from 'node:path';

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

/**
 * Resolve the app root — the directory where `.syncengine/dev/` lives.
 *
 * This is simply CWD: the user runs `syncengine dev` from their app
 * directory, and the state dir is created there. No monorepo walk —
 * external users won't have a `pnpm-workspace.yaml`.
 */
export async function findAppRoot(): Promise<string> {
    return process.cwd();
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

/** Atomic write: ensure the dir, serialise, flush. Centralised so every
 *  state file writes the same way (same indent, same mkdirSync call). */
function writeStateFile(stateDir: string, path: string, data: unknown): void {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Returns parsed JSON or null for missing / unparseable — matches the
 *  "trust nothing, fall back to defaults" pattern every reader wants. */
function readStateFile<T>(path: string): T | null {
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
        return null;
    }
}

export function writePorts(stateDir: string, ports: Ports): void {
    writeStateFile(stateDir, portsFilePath(stateDir), ports);
}

export function readPorts(stateDir: string): Ports | null {
    return readStateFile<Ports>(portsFilePath(stateDir));
}

/** Returns recorded ports if present, otherwise the static defaults. */
export function readPortsOrDefaults(stateDir: string): Ports {
    return readPorts(stateDir) ?? DEFAULT_PORTS;
}

export function writePids(stateDir: string, pids: Pids): void {
    writeStateFile(stateDir, pidsFilePath(stateDir), pids);
}

export function readPids(stateDir: string): Pids | null {
    return readStateFile<Pids>(pidsFilePath(stateDir));
}

export function writeRuntimeConfig(stateDir: string, config: RuntimeConfig): void {
    writeStateFile(stateDir, runtimeConfigPath(stateDir), config);
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
