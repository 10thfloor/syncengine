/**
 * RPC proxy for the scale-out `syncengine serve` edge.
 *
 * The browser invokes workflows, heartbeats, and entity handlers via
 * same-origin `/__syncengine/rpc/...` calls. In the single-process
 * (`syncengine start`) path, the Node bundle's `handleRpc` in
 * @syncengine/server/serve catches those and forwards to Restate's
 * ingress. In the scale-out topology this binary is the edge, so the
 * same proxy contract lives here.
 *
 * Path resolution / validation is shared with the dev middleware and
 * the Node bundle via `@syncengine/http-core`'s rpc-proxy helpers;
 * this module only handles the fetch + response plumbing that varies
 * between Bun and Node APIs.
 */

import { hashWorkspaceId } from '@syncengine/core/http';
import {
    isRpcError,
    resolveEntityTarget,
    resolveHeartbeatTarget,
    resolveWorkflowTarget,
    resolveWorkspaceId,
    type RpcTarget,
    type RpcError,
} from '@syncengine/http-core';
import { instrument, type RpcKind } from '@syncengine/observe';

export interface RpcProxyOptions {
    /** Restate ingress URL reachable from THIS process's network.
     *  e.g. http://restate:8080 in the Docker compose. */
    readonly restateUrl: string;
}

const RPC_PREFIX = '/__syncengine/rpc/';
const WORKFLOW_SUBPATH = 'workflow/';
const HEARTBEAT_SUBPATH = 'heartbeat/';

/**
 * Build a handler that returns a Response for any RPC request and
 * `null` for paths it doesn't own. Intended to be tried before the
 * static + HTML handlers.
 */
export function createRpcHandler(opts: RpcProxyOptions) {
    const restateUrl = opts.restateUrl;
    // Fallback to `default` workspace when the client didn't stamp the
    // x-syncengine-workspace header; `hashWorkspaceId` is deterministic
    // so both edge and server reach the same wsKey for that case.
    const defaultWsKey = () => hashWorkspaceId('default');

    return async (req: Request): Promise<Response | null> => {
        const url = new URL(req.url);
        const pathname = url.pathname;
        if (!pathname.startsWith(RPC_PREFIX)) return null;

        // RPC calls are POST-only; pre-empt anything else with 405.
        if (req.method !== 'POST') {
            return plainText(405, 'method not allowed', {
                allow: 'POST',
            });
        }

        const wsResult = resolveWorkspaceId(
            req.headers.get('x-syncengine-workspace') ?? undefined,
            defaultWsKey,
        );
        if (isRpcError(wsResult)) {
            return plainText(wsResult.status, wsResult.message);
        }

        const target = chooseTarget(pathname, wsResult, restateUrl);
        if (isRpcError(target)) {
            return plainText(target.status, target.message);
        }

        const rpcAttrs = classifyRpc(pathname, wsResult);

        const requestId =
            req.headers.get('x-request-id') ?? crypto.randomUUID();

        // Read the body eagerly. RPC payloads are small JSON (< 1 KB
        // typical); streaming with `duplex: 'half'` adds noticeable
        // latency for no benefit and behaves inconsistently across
        // fetch implementations.
        const bodyText = await req.text();

        return instrument.rpc(rpcAttrs, async () => {
            let upstream: Response;
            try {
                upstream = await fetch(target.url, {
                    method: 'POST',
                    headers: {
                        'content-type':
                            req.headers.get('content-type') ?? 'application/json',
                        // Forward the workspace + request id so server-side
                        // logs can tie Restate entries back to the original
                        // browser request.
                        'x-syncengine-workspace': wsResult,
                        'x-request-id': requestId,
                        // W3C TraceContext — Restate relays these as-is into
                        // ctx.request().headers; the handler-side adapter
                        // (entity-runtime's instrument.withRemoteParent)
                        // extracts them and nests handler spans under this
                        // outbound rpc.* span.
                        ...instrument.traceHeaders(),
                    },
                    body: bodyText,
                });
            } catch (err) {
                return plainText(
                    502,
                    `[syncengine] failed to reach Restate at ${target.url}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                    { 'x-request-id': requestId },
                );
            }

            // Pass-through the Restate response. Preserve status + content
            // type; stamp request-id for log correlation. Buffer the body
            // for the same reason we buffer the request — small JSON, and
            // streaming proxies through Bun have shown adverse latency.
            const responseText = await upstream.text();
            const headers = new Headers();
            const ct = upstream.headers.get('content-type');
            if (ct) headers.set('content-type', ct);
            headers.set('x-request-id', requestId);

            return new Response(responseText, {
                status: upstream.status,
                headers,
            });
        });
    };
}

/** Parse an RPC pathname into the attribute bag instrument.rpc expects.
 *  We re-parse here rather than threading parsed parts through the
 *  http-core target resolvers because the resolvers' return shape is a
 *  Restate URL, which we don't want to widen just for telemetry. */
function classifyRpc(
    pathname: string,
    workspace: string,
): { kind: RpcKind; name: string; handler?: string; workspace: string } {
    const rest = pathname.slice(RPC_PREFIX.length);
    if (rest.startsWith(WORKFLOW_SUBPATH)) {
        const [name] = rest.slice(WORKFLOW_SUBPATH.length).split('/');
        return { kind: 'workflow', name: name ?? 'unknown', workspace };
    }
    if (rest.startsWith(HEARTBEAT_SUBPATH)) {
        const [name] = rest.slice(HEARTBEAT_SUBPATH.length).split('/');
        return { kind: 'heartbeat', name: name ?? 'unknown', workspace };
    }
    // Entity: <entity>/<key>/<handler>
    const parts = rest.split('/');
    const name = parts[0] ?? 'unknown';
    const handler = parts[2] ?? 'unknown';
    return { kind: 'entity', name, handler, workspace };
}

function chooseTarget(
    pathname: string,
    workspaceId: string,
    restateUrl: string,
): RpcTarget | RpcError {
    const rest = pathname.slice(RPC_PREFIX.length);
    if (rest.startsWith(WORKFLOW_SUBPATH)) {
        return resolveWorkflowTarget(pathname, workspaceId, restateUrl);
    }
    if (rest.startsWith(HEARTBEAT_SUBPATH)) {
        return resolveHeartbeatTarget(pathname, workspaceId, restateUrl);
    }
    return resolveEntityTarget(pathname, workspaceId, restateUrl);
}

function plainText(
    status: number,
    body: string,
    extraHeaders: Record<string, string> = {},
): Response {
    return new Response(body, {
        status,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            ...extraHeaders,
        },
    });
}
