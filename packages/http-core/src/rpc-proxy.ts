/**
 * Shared RPC proxy resolution logic.
 *
 * Both the Vite dev middleware (`@syncengine/vite-plugin`) and the
 * production HTTP server (`serve.ts`) need to validate incoming RPC
 * requests and build the Restate ingress URL. This module extracts
 * those pure functions so the two call-sites stay in sync without
 * copy-pasting ~130 lines of validation and URL construction.
 *
 * Callers are responsible for body reading and HTTP response writing
 * (those differ between Connect middleware and raw Node `http`).
 */

// Inline the prefix constants to avoid importing heavy server modules
// (entity-runtime.js, workflow.js) which pull in @restatedev/restate-sdk.
// This module is used by @syncengine/vite-plugin which runs in Vite's
// Node process where those transitive deps may not resolve.
const ENTITY_OBJECT_PREFIX = 'entity_';
const WORKFLOW_OBJECT_PREFIX = 'workflow_';
const HEARTBEAT_WORKFLOW_PREFIX = 'heartbeat_';

// ── Validation regexes ────────────────────────────────────────────────────

/**
 * Entity / handler / workflow name constraint. Must start with a letter
 * or underscore-followed-by-alphanumeric, then any number of word chars.
 */
const NAME_REGEX = /^([a-zA-Z]|_[a-zA-Z0-9])[a-zA-Z0-9_]*$/;

/**
 * Workspace header constraint. Allows hex hashes, `default`, and similar
 * safe identifiers up to 64 characters.
 */
const WORKSPACE_HEADER_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export { NAME_REGEX, WORKSPACE_HEADER_REGEX };

// ── Result types ──────────────────────────────────────────────────────────

export interface RpcTarget {
    url: string;
}

export interface RpcError {
    status: number;
    message: string;
}

export function isRpcError(result: RpcTarget | RpcError | string): result is RpcError {
    return typeof result === 'object' && 'status' in result && !('url' in result);
}

// ── Workspace resolution ──────────────────────────────────────────────────

/**
 * Resolve the workspace id from the `x-syncengine-workspace` header.
 *
 * @param headerValue - The raw header value (string, string[], or undefined).
 * @param fallback    - Called when the header is absent/empty; should return
 *                      the default workspace id (e.g. `hashWorkspaceId('default')`).
 */
export function resolveWorkspaceId(
    headerValue: string | string[] | undefined,
    fallback: () => string,
): string | RpcError {
    const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (typeof value === 'string' && value.length > 0) {
        if (!WORKSPACE_HEADER_REGEX.test(value)) {
            return { status: 400, message: 'Invalid x-syncengine-workspace header' };
        }
        return value;
    }
    return fallback();
}

// ── Workflow target resolution ────────────────────────────────────────────

/**
 * Validate a workflow RPC pathname and return the Restate ingress URL.
 *
 * @param pathname    - Full URL pathname starting with `/__syncengine/rpc/workflow/`.
 * @param workspaceId - Already-resolved workspace id.
 * @param restateUrl  - Restate ingress base URL (trailing slashes are stripped).
 */
export function resolveWorkflowTarget(
    pathname: string,
    workspaceId: string,
    restateUrl: string,
): RpcTarget | RpcError {
    const wfParts = pathname.slice('/__syncengine/rpc/workflow/'.length).split('/');
    if (wfParts.length !== 2) {
        return { status: 400, message: 'Expected /__syncengine/rpc/workflow/<name>/<invocationId>' };
    }
    const [wfNameRaw, invocationIdRaw] = wfParts as [string, string];

    let wfName: string;
    let invocationId: string;
    try {
        wfName = decodeURIComponent(wfNameRaw);
        invocationId = decodeURIComponent(invocationIdRaw);
    } catch {
        return { status: 400, message: 'Malformed URL-encoded path component' };
    }

    if (!NAME_REGEX.test(wfName)) {
        return { status: 400, message: 'Invalid workflow name' };
    }
    // eslint-disable-next-line no-control-regex
    if (invocationId.length === 0 || invocationId.length > 512 || /[\x00-\x1f]/.test(invocationId)) {
        return { status: 400, message: 'Invalid invocationId' };
    }

    const base = restateUrl.replace(/\/+$/, '');
    const url =
        `${base}/${WORKFLOW_OBJECT_PREFIX}${wfName}` +
        `/${encodeURIComponent(`${workspaceId}/${invocationId}`)}/run`;

    return { url };
}

// ── Heartbeat target resolution ───────────────────────────────────────────

/**
 * Resolve a heartbeat RPC pathname `/rpc/heartbeat/<name>/<invocationId>`
 * to the Restate ingress URL. Heartbeats register as workflows under the
 * `heartbeat_` prefix (distinct from user workflows under `workflow_`),
 * so they get their own proxy route rather than sharing the `/rpc/workflow/`
 * namespace.
 */
export function resolveHeartbeatTarget(
    pathname: string,
    workspaceId: string,
    restateUrl: string,
): RpcTarget | RpcError {
    const parts = pathname.slice('/__syncengine/rpc/heartbeat/'.length).split('/');
    if (parts.length !== 2) {
        return { status: 400, message: 'Expected /__syncengine/rpc/heartbeat/<name>/<invocationId>' };
    }
    const [hbNameRaw, invocationIdRaw] = parts as [string, string];

    let hbName: string;
    let invocationId: string;
    try {
        hbName = decodeURIComponent(hbNameRaw);
        invocationId = decodeURIComponent(invocationIdRaw);
    } catch {
        return { status: 400, message: 'Malformed URL-encoded path component' };
    }

    if (!NAME_REGEX.test(hbName)) {
        return { status: 400, message: 'Invalid heartbeat name' };
    }
    // eslint-disable-next-line no-control-regex
    if (invocationId.length === 0 || invocationId.length > 512 || /[\x00-\x1f]/.test(invocationId)) {
        return { status: 400, message: 'Invalid invocationId' };
    }

    const base = restateUrl.replace(/\/+$/, '');
    const url =
        `${base}/${HEARTBEAT_WORKFLOW_PREFIX}${hbName}` +
        `/${encodeURIComponent(`${workspaceId}/${invocationId}`)}/run`;

    return { url };
}

// ── Entity target resolution ──────────────────────────────────────────────

/**
 * Validate an entity RPC pathname and return the Restate ingress URL.
 *
 * @param pathname    - Full URL pathname starting with `/__syncengine/rpc/`.
 * @param workspaceId - Already-resolved workspace id.
 * @param restateUrl  - Restate ingress base URL (trailing slashes are stripped).
 */
export function resolveEntityTarget(
    pathname: string,
    workspaceId: string,
    restateUrl: string,
): RpcTarget | RpcError {
    const pathParts = pathname.slice('/__syncengine/rpc/'.length).split('/');
    if (pathParts.length !== 3) {
        return { status: 400, message: 'Expected /__syncengine/rpc/<entity>/<key>/<handler>' };
    }
    const [entityNameRaw, entityKeyRaw, handlerNameRaw] = pathParts as [string, string, string];

    let entityName: string;
    let entityKey: string;
    let handlerName: string;
    try {
        entityName = decodeURIComponent(entityNameRaw);
        entityKey = decodeURIComponent(entityKeyRaw);
        handlerName = decodeURIComponent(handlerNameRaw);
    } catch {
        return { status: 400, message: 'Malformed URL-encoded path component' };
    }

    if (!NAME_REGEX.test(entityName) || !NAME_REGEX.test(handlerName)) {
        return { status: 400, message: 'Invalid entity or handler name' };
    }
    // eslint-disable-next-line no-control-regex
    if (entityKey.length === 0 || entityKey.length > 512 || /[\/\\\x00-\x1f]/.test(entityKey)) {
        return { status: 400, message: 'Invalid entity key' };
    }

    const base = restateUrl.replace(/\/+$/, '');
    const url =
        `${base}/${ENTITY_OBJECT_PREFIX}${entityName}` +
        `/${encodeURIComponent(`${workspaceId}/${entityKey}`)}` +
        `/${handlerName}`;

    return { url };
}
