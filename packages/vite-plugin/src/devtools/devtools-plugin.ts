/**
 * `@syncengine/vite-plugin` — devtools sub-plugin.
 *
 * Responsibilities:
 *
 *   1. Inject the devtools client script into the served HTML (dev only).
 *   2. Expose `GET /__syncengine/devtools/metrics` — aggregated health data
 *      from NATS JetStream, Restate, and the active workspace.
 *   3. Expose `POST /__syncengine/devtools/action` — server-side action
 *      handlers for purging streams, triggering GC, teardown, and reset.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Connect, Plugin } from 'vite';

// ── Constants ─────────────────────────────────────────────────────────────────

const METRICS_PATH = '/__syncengine/devtools/metrics';
const ACTION_PATH = '/__syncengine/devtools/action';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive the Restate admin port from the ingress URL (8080 → 9070). */
function restateAdminUrl(restateIngressUrl: string): string {
    return restateIngressUrl
        .replace(/\/+$/, '')
        .replace(/:8080\b/, ':9070');
}

/** Read `.syncengine/dev/runtime.json` from the project root. */
interface DevRuntimeJson {
    natsUrl?: string;
    restateUrl?: string;
    gatewayUrl?: string;
    authToken?: string | null;
}

function readDevRuntime(viteRoot: string): DevRuntimeJson {
    const path = join(viteRoot, '.syncengine', 'dev', 'runtime.json');
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as DevRuntimeJson;
    } catch {
        return {};
    }
}

// ── NATS monitor helpers ──────────────────────────────────────────────────────

interface NatsStreamInfo {
    name: string;
    messages: number;
    bytes: number;
    firstSeq: number;
    lastSeq: number;
    consumerCount: number;
}

async function fetchNatsStreams(): Promise<NatsStreamInfo[]> {
    try {
        const res = await fetch('http://127.0.0.1:8222/jsz?streams=true');
        if (!res.ok) return [];
        const data = (await res.json()) as {
            account_details?: Array<{
                stream_detail?: Array<{
                    name: string;
                    state?: {
                        messages?: number;
                        bytes?: number;
                        first_seq?: number;
                        last_seq?: number;
                        consumer_count?: number;
                    };
                }>;
            }>;
        };
        // Stream data lives in account_details[].stream_detail[], not at top level
        const allStreams = (data.account_details ?? []).flatMap(
            (a) => a.stream_detail ?? [],
        );
        return allStreams
            .filter((s) => s.name.startsWith('WS_'))
            .map((s) => ({
                name: s.name,
                messages: s.state?.messages ?? 0,
                bytes: s.state?.bytes ?? 0,
                firstSeq: s.state?.first_seq ?? 0,
                lastSeq: s.state?.last_seq ?? 0,
                consumerCount: s.state?.consumer_count ?? 0,
            }));
    } catch {
        return [];
    }
}

/** Find the first WS_* stream name from NATS monitor — used as workspace id. */
async function resolveWorkspaceIdFromNats(): Promise<string | null> {
    const streams = await fetchNatsStreams();
    if (streams.length === 0) return null;
    // Pick the stream with the most messages (the active workspace),
    // not just the first one — there may be stale empty streams.
    const sorted = [...streams].sort((a, b) => b.messages - a.messages);
    return sorted[0]!.name.replace(/^WS_/, '');
}

// ── Restate helpers ───────────────────────────────────────────────────────────

async function fetchRestateHealth(adminUrl: string): Promise<{ healthy: boolean; services: unknown[] }> {
    try {
        const res = await fetch(`${adminUrl}/health`);
        return { healthy: res.ok, services: [] };
    } catch {
        return { healthy: false, services: [] };
    }
}

async function restatePost(
    ingressUrl: string,
    path: string,
    body: unknown,
): Promise<unknown> {
    const url = `${ingressUrl.replace(/\/+$/, '')}/${path}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(`POST ${url} → HTTP ${res.status}: ${text}`);
    }
    return res.json();
}

/**
 * Clear all Restate virtual object state for entity_ and workflow_ services.
 * Uses the admin API: POST /services/{service}/state with { object_key, new_state: {} }.
 * First queries all deployments to find entity/workflow services, then uses
 * the SQL query endpoint to find all keys, then clears each.
 */
async function clearAllEntityState(restateUrl: string): Promise<number> {
    const adminUrl = restateAdminUrl(restateUrl);
    let cleared = 0;

    // 1. Get all registered services
    let services: Array<{ name: string; ty: string }> = [];
    try {
        const res = await fetch(`${adminUrl}/services`);
        if (res.ok) {
            const data = (await res.json()) as { services: Array<{ name: string; ty: string }> };
            services = (data.services ?? []).filter(
                (s) => s.name.startsWith('entity_') || s.name.startsWith('workflow_') || s.name === 'workspace',
            );
        }
    } catch { /* admin unreachable */ }

    // 2. For each service, query keys and clear state
    for (const svc of services) {
        try {
            // Use the Restate SQL query to find all object keys
            const qRes = await fetch(`${adminUrl}/query`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'accept': 'application/json' },
                body: JSON.stringify({ query: `SELECT DISTINCT service_key FROM state WHERE service_name = '${svc.name}'` }),
            });
            if (!qRes.ok) continue;

            // The query endpoint returns Arrow IPC by default; with accept: application/json it returns JSON
            const qData = await qRes.json() as { rows?: string[][] };
            const keys = (qData.rows ?? []).map((r: string[]) => r[0]).filter(Boolean);

            for (const key of keys) {
                try {
                    await fetch(`${adminUrl}/services/${svc.name}/state`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ object_key: key, new_state: {} }),
                    });
                    cleared++;
                } catch { /* individual clear failure */ }
            }
        } catch { /* query failure */ }
    }

    return cleared;
}

// ── Workspace info ────────────────────────────────────────────────────────────

async function fetchWorkspaceInfo(
    restateUrl: string,
    wsId: string,
): Promise<{ id: string; active: boolean; members: unknown[]; schemaVersion: unknown }> {
    const base = restateUrl.replace(/\/+$/, '');
    let active = false;
    let members: unknown[] = [];
    let schemaVersion: unknown = null;

    try {
        const stateResult = (await restatePost(base, `workspace/${encodeURIComponent(wsId)}/getState`, null)) as {
            active?: boolean;
            schemaVersion?: unknown;
        };
        active = stateResult?.active ?? false;
        schemaVersion = stateResult?.schemaVersion ?? null;
    } catch {
        // leave defaults
    }

    try {
        const membersResult = (await restatePost(base, `workspace/${encodeURIComponent(wsId)}/listMembers`, null)) as unknown[];
        members = Array.isArray(membersResult) ? membersResult : [];
    } catch {
        // leave defaults
    }

    return { id: wsId, active, members, schemaVersion };
}

// ── Middleware ────────────────────────────────────────────────────────────────

export function devtoolsMiddleware(
    getRuntimeFn: () => DevRuntimeJson,
): Connect.NextHandleFunction {
    return async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';

        // ── GET /__syncengine/devtools/metrics ────────────────────────────
        if (url === METRICS_PATH && req.method === 'GET') {
            const runtime = getRuntimeFn();
            const restateUrl = runtime.restateUrl ?? 'http://localhost:8080';
            const adminUrl = restateAdminUrl(restateUrl);

            // Prefer workspace ID from query param (sent by the devtools client
            // which reads it from the <meta> tag). Fall back to NATS stream heuristic.
            const qs = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
            const clientWsId = qs.get('wsId');

            const [natsStreams, restateHealth] = await Promise.all([
                fetchNatsStreams(),
                fetchRestateHealth(adminUrl),
            ]);

            const wsId = clientWsId
                || (natsStreams.length > 0 ? natsStreams[0]!.name.replace(/^WS_/, '') : 'default');

            const workspace = await fetchWorkspaceInfo(restateUrl, wsId);

            const payload = {
                nats: { streams: natsStreams },
                restate: restateHealth,
                workspace,
            };

            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(payload));
            return;
        }

        // ── POST /__syncengine/devtools/action ────────────────────────────
        if (url === ACTION_PATH && req.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const raw = Buffer.concat(chunks).toString('utf8') || '{}';

            let body: { action?: string; streamName?: string; workspaceId?: string };
            try {
                body = JSON.parse(raw) as { action?: string; streamName?: string };
            } catch {
                res.statusCode = 400;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ ok: false, message: 'invalid JSON' }));
                return;
            }

            const { action, streamName, workspaceId: clientWsId } = body;
            const runtime = getRuntimeFn();
            const restateUrl = runtime.restateUrl ?? 'http://localhost:8080';
            const natsUrl = runtime.natsUrl ?? 'ws://localhost:9222';

            // Convert ws:// → nats:// for the node transport
            const natsServerUrl = natsUrl.replace(/^ws:\/\//, 'nats://').replace(/^wss:\/\//, 'nats://');

            // Prefer workspace ID from client (read from <meta> tag), fall back to NATS heuristic
            const resolvedWsId = clientWsId || await resolveWorkspaceIdFromNats() || 'default';

            let result: { ok: boolean; message: string };

            try {
                switch (action) {
                    case 'force-reconnect':
                    case 'clear-client-db':
                        result = { ok: true, message: 'client-only' };
                        break;

                    case 'purge-stream': {
                        const targetStream = streamName ?? await (async () => {
                            const streams = await fetchNatsStreams();
                            return streams[0]?.name ?? null;
                        })();

                        if (!targetStream) {
                            result = { ok: false, message: 'no stream found to purge' };
                            break;
                        }

                        const { connect } = await import('@nats-io/transport-node');
                        const { jetstreamManager } = await import('@nats-io/jetstream');
                        const nc = await connect({ servers: natsServerUrl });
                        try {
                            const jsm = await jetstreamManager(nc);
                            await jsm.streams.purge(targetStream);
                            result = { ok: true, message: `purged stream ${targetStream}` };
                        } finally {
                            await nc.drain().catch(() => { /* ignore */ });
                        }
                        break;
                    }

                    case 'trigger-gc': {
                        const wsId = resolvedWsId;
                        await restatePost(
                            restateUrl,
                            `workspace/${encodeURIComponent(wsId)}/triggerGC`,
                            null,
                        );
                        result = { ok: true, message: `triggered GC for workspace ${wsId}` };
                        break;
                    }

                    case 'teardown': {
                        const wsId = resolvedWsId;
                        await restatePost(
                            restateUrl,
                            `workspace/${encodeURIComponent(wsId)}/teardown`,
                            null,
                        );
                        result = { ok: true, message: `teardown workspace ${wsId}` };
                        break;
                    }

                    case 'reset': {
                        const wsId = resolvedWsId;
                        const base = restateUrl.replace(/\/+$/, '');
                        const wsEnc = encodeURIComponent(wsId);

                        // 1. Purge the WS_ stream
                        const streamToPurge = `WS_${wsId}`;
                        try {
                            const { connect } = await import('@nats-io/transport-node');
                            const { jetstreamManager } = await import('@nats-io/jetstream');
                            const nc = await connect({ servers: natsServerUrl });
                            try {
                                const jsm = await jetstreamManager(nc);
                                await jsm.streams.purge(streamToPurge);
                            } finally {
                                await nc.drain().catch(() => { /* ignore */ });
                            }
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            // Non-fatal: stream may not exist yet
                            console.warn(`[syncengine:devtools] purge stream ${streamToPurge} failed: ${msg}`);
                        }

                        // 2. Clear all entity/workflow state in Restate
                        const cleared = await clearAllEntityState(restateUrl);
                        if (cleared > 0) {
                            console.log(`[syncengine:devtools] cleared ${cleared} entity state entries`);
                        }

                        // 3. Teardown workspace
                        await restatePost(base, `workspace/${wsEnc}/teardown`, null);

                        // 4. Re-provision
                        await restatePost(
                            base,
                            `workspace/${wsEnc}/provision`,
                            [{ workspaceId: wsId, tenantId: 'default' }],
                        );

                        result = { ok: true, message: `reset workspace ${wsId}` };
                        break;
                    }

                    default:
                        result = { ok: false, message: `unknown action: ${String(action)}` };
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                result = { ok: false, message: msg };
            }

            res.statusCode = result.ok ? 200 : 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(result));
            return;
        }

        next();
    };
}

// ── Plugin factory ────────────────────────────────────────────────────────────

export function devtoolsPlugin(): Plugin {
    let isDev = false;
    let viteRoot = '';

    // Compute __dirname equivalent at module load time (ESM).
    const pluginDir = fileURLToPath(new URL('.', import.meta.url));

    return {
        name: 'syncengine:devtools',

        configResolved(config) {
            isDev = config.command === 'serve';
            viteRoot = config.root;
        },

        configureServer(server) {
            if (!isDev) return;
            server.middlewares.use(
                devtoolsMiddleware(() => readDevRuntime(viteRoot || server.config.root)),
            );
        },

        transformIndexHtml(html) {
            if (!isDev) return html;

            const clientJs = readFileSync(join(pluginDir, 'devtools-client.js'), 'utf8');
            const styles = readFileSync(join(pluginDir, 'devtools-styles.css'), 'utf8');

            // Escape backticks and template-literal delimiters so the CSS
            // string can be safely embedded inside a JS template literal.
            const escapedStyles = styles
                .replace(/\\/g, '\\\\')
                .replace(/`/g, '\\`')
                .replace(/\$\{/g, '\\${');

            const injected = [
                `<script type="module">`,
                `const __DEVTOOLS_STYLES__ = \`${escapedStyles}\`;`,
                clientJs,
                `</script>`,
            ].join('\n');

            return html.replace('</body>', `${injected}\n</body>`);
        },
    };
}
