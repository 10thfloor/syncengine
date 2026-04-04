/**
 * Thin HTTP client for the Restate admin/ingress APIs and the NATS monitor
 * endpoint. Used by `status`, `workspace *`, and internally by `dev` for
 * registration and auto-provisioning.
 *
 * All calls include a friendly "is the stack even running?" precheck —
 * if Restate isn't reachable, we fail with a helpful message instead of a
 * raw ECONNREFUSED.
 */

import type { Ports } from './state';

/** Timeout used for all "is the service up?" soft probes. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Fetch `url` with a short timeout. Any network error, timeout, or
 * non-2xx response collapses to `null` — callers branch on truthiness
 * instead of wrapping every call in try/catch.
 */
async function softFetch(url: string, init?: RequestInit): Promise<Response | null> {
    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            ...init,
        });
        return res.ok ? res : null;
    } catch {
        return null;
    }
}

// ── Stack reachability ────────────────────────────────────────────────────

export class StackNotRunningError extends Error {
    constructor(detail: string) {
        super(
            `No syncengine dev stack is running.\n` +
            `  ${detail}\n\n` +
            `Start one with: \x1b[1mpnpm dev\x1b[0m`,
        );
        this.name = 'StackNotRunningError';
    }
}

export async function requireStackRunning(ports: Ports): Promise<void> {
    if (await restateHealth(ports)) return;
    throw new StackNotRunningError(
        `Restate admin on :${ports.restateAdmin} is unreachable`,
    );
}

// ── Restate admin ─────────────────────────────────────────────────────────

export async function restateHealth(ports: Ports): Promise<boolean> {
    const res = await softFetch(`http://127.0.0.1:${ports.restateAdmin}/health`);
    return res !== null;
}

export async function restateRegisterDeployment(
    ports: Ports,
    serviceUri: string,
    opts: { force?: boolean } = {},
): Promise<void> {
    // `force: true` tells the Restate admin API to re-discover the
    // deployment even if one with the same URI is already registered.
    // That's exactly what we need for PLAN Phase 7 hot-reload: when a
    // `.actor.ts` file changes and tsx restarts the workspace service,
    // the service metadata (handler list, schemas) may have changed but
    // the admin has the old version cached. Force-registering triggers
    // discovery against the running server and updates the metadata
    // without touching the persistent virtual-object state (which is
    // keyed by workspace id, independent of deployment version).
    const res = await fetch(
        `http://127.0.0.1:${ports.restateAdmin}/deployments`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ uri: serviceUri, force: opts.force ?? false }),
        },
    );
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`restate deployment registration failed (HTTP ${res.status}): ${body}`);
    }
}

// ── Restate ingress (workspace virtual object handlers) ─────────────────

export interface WorkspaceState {
    workspaceId: string;
    tenantId: string;
    schemaVersion: number;
    streamName: string;
    createdAt: string;
    status: 'provisioning' | 'active' | 'teardown' | 'deleted';
}

async function invokeWorkspace<T>(
    ports: Ports,
    workspaceId: string,
    handler: string,
    body: unknown = {},
): Promise<T> {
    await requireStackRunning(ports);
    // Both path segments must be percent-encoded. All current callers pass
    // literal handler names, but future callers shouldn't be able to inject
    // path traversal or query params via an un-encoded handler argument.
    const url = `http://127.0.0.1:${ports.restateIngress}/workspace/${encodeURIComponent(workspaceId)}/${encodeURIComponent(handler)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`workspace.${handler}('${workspaceId}') → HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
}

export function provisionWorkspace(
    ports: Ports,
    workspaceId: string,
    tenantId = 'default',
): Promise<WorkspaceState> {
    return invokeWorkspace<WorkspaceState>(ports, workspaceId, 'provision', { tenantId });
}

export function getWorkspaceState(
    ports: Ports,
    workspaceId: string,
): Promise<WorkspaceState | null> {
    return invokeWorkspace<WorkspaceState | null>(ports, workspaceId, 'getState');
}

export function teardownWorkspace(
    ports: Ports,
    workspaceId: string,
): Promise<{ deleted: boolean }> {
    return invokeWorkspace<{ deleted: boolean }>(ports, workspaceId, 'teardown');
}

export interface WorkspaceMember {
    userId: string;
    role: string;
    addedAt: string;
}

export function listWorkspaceMembers(
    ports: Ports,
    workspaceId: string,
): Promise<{ members: WorkspaceMember[] }> {
    return invokeWorkspace(ports, workspaceId, 'listMembers');
}

// ── NATS monitor (JetStream stream discovery) ───────────────────────────

interface JetStreamInfo {
    streams: number;
    consumers: number;
    messages: number;
    bytes: number;
}

interface JetStreamStreamEntry {
    name: string;
    state: {
        messages: number;
        bytes: number;
        first_seq: number;
        last_seq: number;
        consumer_count: number;
    };
    config: {
        subjects: string[];
        retention: string;
    };
}

export async function natsJetstreamInfo(ports: Ports): Promise<JetStreamInfo | null> {
    const res = await softFetch(`http://127.0.0.1:${ports.natsMonitor}/jsz`);
    if (!res) return null;
    return (await res.json()) as JetStreamInfo;
}

export async function natsListStreams(ports: Ports): Promise<JetStreamStreamEntry[]> {
    const res = await fetch(
        `http://127.0.0.1:${ports.natsMonitor}/jsz?streams=true&config=true`,
    );
    if (!res.ok) throw new Error(`nats /jsz returned HTTP ${res.status}`);
    const body = (await res.json()) as {
        account_details?: Array<{
            stream_detail?: JetStreamStreamEntry[];
        }>;
    };
    const details = body.account_details ?? [];
    return details.flatMap((a) => a.stream_detail ?? []);
}

/**
 * Extract a workspace id from a JetStream stream name following the
 * `WS_<id_with_underscores>` convention used by the workspace service.
 */
export function streamNameToWorkspaceId(streamName: string): string | null {
    const m = streamName.match(/^WS_(.+)$/);
    if (!m) return null;
    // Workspace ids had hyphens replaced with underscores at stream creation.
    // Keep the underscore form here — it's the canonical id the user would
    // pass back to `workspace info`, since provision() also replaces hyphens.
    return m[1];
}
