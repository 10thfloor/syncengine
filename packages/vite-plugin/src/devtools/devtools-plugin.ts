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
const STREAM_PATH = '/__syncengine/devtools/stream';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive the Restate admin port from the ingress URL (8080 → 9070). */
function restateAdminUrl(restateIngressUrl: string): string {
    return restateIngressUrl
        .replace(/\/+$/, '')
        .replace(/:8080\b/, ':9070');
}

import { readDevRuntime, type DevRuntimeJson } from '../dev-runtime.ts';

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

// ── Workspace info ────────────────────────────────────────────────────────────

/**
 * Read workspace state directly from the Restate admin SQL query API
 * instead of invoking getState/listMembers through the ingress. This
 * avoids serializing metrics polling with real workspace handlers (e.g.
 * reset) and eliminates the noisy invocation logs.
 */
async function fetchWorkspaceInfo(
    restateUrl: string,
    wsId: string,
): Promise<{ id: string; active: boolean; members: unknown[]; schemaVersion: unknown }> {
    const adminUrl = restateAdminUrl(restateUrl);
    let active = false;
    let members: unknown[] = [];
    let schemaVersion: unknown = null;

    try {
        const res = await fetch(`${adminUrl}/query`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
                query: `SELECT key, value_utf8 FROM state WHERE service_name = 'workspace' AND service_key = '${wsId.replace(/'/g, "''")}'`,
            }),
        });
        if (res.ok) {
            const data = (await res.json()) as { rows?: Array<{ key: string; value_utf8: string }> };
            for (const row of data.rows ?? []) {
                try {
                    const val = JSON.parse(row.value_utf8);
                    if (row.key === 'state') {
                        active = val?.status === 'active';
                        schemaVersion = val?.schemaVersion ?? null;
                    } else if (row.key === 'members') {
                        members = Array.isArray(val) ? val : [];
                    }
                } catch { /* skip unparseable */ }
            }
        }
    } catch {
        // admin unreachable — leave defaults
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

            // Use already-fetched streams to resolve wsId (avoids double NATS fetch)
            const wsId = clientWsId
                || (natsStreams.length > 0
                    ? [...natsStreams].sort((a, b) => b.messages - a.messages)[0]!.name.replace(/^WS_/, '')
                    : 'default');

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
                            await nc.close();
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

                        // Single Restate call: workspace/reset handles stream
                        // deletion, entity state clearing, and re-provisioning
                        // server-side — no N+1 HTTP round trips from here.
                        const resetResult = await restatePost(
                            base,
                            `workspace/${wsEnc}/reset`,
                            { tenantId: 'default' },
                        ) as { ok: boolean; message: string };

                        result = resetResult;
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

        // ── GET /__syncengine/devtools/stream ────────────────────────────
        if (url === STREAM_PATH && req.method === 'GET') {
            const qs = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
            const limit = Math.min(parseInt(qs.get('limit') ?? '100', 10), 500);
            // Use NATS TCP port (4222), not the WebSocket port from runtime.json
            const natsUrl = 'nats://127.0.0.1:4222';

            try {
                const streams = await fetchNatsStreams();
                if (streams.length === 0) {
                    res.statusCode = 200;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ messages: [], stream: null }));
                    return;
                }
                const streamMeta = [...streams].sort((a, b) => b.messages - a.messages)[0]!;

                const { connect } = await import('@nats-io/transport-node');
                const { jetstream } = await import('@nats-io/jetstream');
                const nc = await connect({ servers: natsUrl });
                const messages: Array<{ seq: number; subject: string; data: unknown }> = [];

                try {
                    const js = jetstream(nc);
                    const stream = await js.streams.get(streamMeta.name);
                    const startSeq = Math.max(streamMeta.firstSeq, streamMeta.lastSeq - limit + 1);
                    for (let seq = startSeq; seq <= streamMeta.lastSeq; seq++) {
                        try {
                            const msg = await stream.getMessage({ seq });
                            if (!msg) continue;
                            let data: unknown;
                            try { data = msg.json(); } catch { data = msg.string(); }
                            messages.push({ seq, subject: msg.subject, data });
                        } catch { /* skip gaps from GC */ }
                    }
                } finally {
                    await nc.close();
                }

                res.statusCode = 200;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({
                    messages,
                    stream: { name: streamMeta.name, messages: streamMeta.messages, firstSeq: streamMeta.firstSeq, lastSeq: streamMeta.lastSeq },
                }));
            } catch (err) {
                res.statusCode = 500;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
            return;
        }

        next();
    };
}

// ── Plugin factory ────────────────────────────────────────────────────────────

export function devtoolsPlugin(): Plugin {
    let isDev = false;
    let viteRoot = '';
    let cachedInjection: string | null = null;
    let runtimeCache: DevRuntimeJson = {};

    const pluginDir = fileURLToPath(new URL('.', import.meta.url));

    return {
        name: 'syncengine:devtools',

        configResolved(config) {
            isDev = config.command === 'serve';
            viteRoot = config.root;
        },

        configureServer(server) {
            if (!isDev) return;

            // Cache runtime.json — refresh on file change instead of reading on every request
            const runtimePath = join(viteRoot || server.config.root, '.syncengine', 'dev', 'runtime.json');
            const reloadRuntime = () => { runtimeCache = readDevRuntime(viteRoot || server.config.root); };
            reloadRuntime();
            server.watcher.add(runtimePath);
            server.watcher.on('change', (f) => { if (f === runtimePath) reloadRuntime(); });
            server.watcher.on('add', (f) => { if (f === runtimePath) reloadRuntime(); });

            // Cache the injection snippet — these files are static for the server's lifetime
            const clientJs = readFileSync(join(pluginDir, 'devtools-client.js'), 'utf8');
            const styles = readFileSync(join(pluginDir, 'devtools-styles.css'), 'utf8');
            const escapedStyles = styles
                .replace(/\\/g, '\\\\')
                .replace(/`/g, '\\`')
                .replace(/\$\{/g, '\\${');
            cachedInjection = [
                `<script type="module">`,
                `const __DEVTOOLS_STYLES__ = \`${escapedStyles}\`;`,
                clientJs,
                `</script>`,
            ].join('\n');

            server.middlewares.use(devtoolsMiddleware(() => runtimeCache));
        },

        transformIndexHtml(html) {
            if (!isDev || !cachedInjection) return html;
            return html.replace('</body>', `${cachedInjection}\n</body>`);
        },
    };
}
