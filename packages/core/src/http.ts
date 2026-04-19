// ── HTTP helpers shared between the Vite plugin (dev) and the
// production server (Phase 9). These are pure functions with no
// framework dependencies — only `node:crypto` for hashing.

import { createHash } from 'node:crypto';
import { errors, ConnectionCode } from './errors';

// ── wsKey derivation ────────────────────────────────────────────────────────

/**
 * Length of the hex-encoded wsKey. 16 hex chars = 64 bits of hash output,
 * which is well below NATS's 255-char subject-token limit and Restate's
 * 2 KiB virtual-object-key limit while still giving us a collision-free
 * namespace for any realistic number of concurrent workspaces (birthday
 * bound ≈ 2³² before a 50% collision chance). Bumping this up is safe
 * for both backends; bumping it down is not — cut more than 8 chars and
 * you start risking collisions on small teams.
 */
export const WSKEY_HEX_CHARS = 16;

/**
 * Hash a user-returned workspace id to a `WSKEY_HEX_CHARS`-character hex
 * `wsKey`. SHA-256 is deterministic, so the same input always produces
 * the same output; a given user consistently maps to the same underlying
 * Restate virtual object and NATS stream across dev restarts.
 */
export function hashWorkspaceId(workspaceId: string): string {
    return createHash('sha256').update(workspaceId).digest('hex').slice(0, WSKEY_HEX_CHARS);
}

// ── Workspace provisioning ─────────────────────────────────────────────────

/**
 * POST to workspace.provision on a Restate ingress. Idempotent — returns
 * immediately if the workspace is already active.
 */
export async function provisionWorkspace(
    restateUrl: string,
    wsKey: string,
    tenantId = 'default',
): Promise<void> {
    const url = `${restateUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(wsKey)}/provision`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        throw errors.connection(ConnectionCode.HTTP_ERROR, {
            message: `workspace.provision(${wsKey}) → HTTP ${res.status}: ${text}`,
            context: { workspace: wsKey, status: res.status },
        });
    }
}

/**
 * POST to workspace.isMember on a Restate ingress. Returns the user's
 * workspace role or `null` when the user is not a member.
 *
 * Used by the gateway's `AuthHook.authorizeChannel` to resolve roles
 * for `Access.role(...)` policies. Runs outside a Restate context
 * (gateway is a plain node process), so it goes through the ingress
 * HTTP API rather than the in-context `objectClient`.
 */
export async function workspaceMemberRole(
    restateUrl: string,
    workspaceId: string,
    userId: string,
): Promise<string | null> {
    const url = `${restateUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(workspaceId)}/isMember`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
    });
    if (!res.ok) {
        // Treat errors as "not a member" rather than crashing the
        // subscribe path. Logs so operators see the failure.
        // eslint-disable-next-line no-console
        console.warn(
            `[auth] workspace.isMember(${workspaceId}, ${userId}) → HTTP ${res.status}`,
        );
        return null;
    }
    const data = (await res.json()) as { isMember?: boolean; role?: string };
    return data.isMember && typeof data.role === 'string' ? data.role : null;
}

// ── HTML meta tag injection ────────────────────────────────────────────────

/**
 * Marker string we look for to decide whether an HTML document has
 * already been processed. Prevents duplicate injection on HMR or
 * double-render.
 */
const META_MARKER = 'name="syncengine-workspace-id"';

/**
 * Inject `<meta name="syncengine-*">` tags into HTML just before
 * `</head>` (or at the top of `<head>` as a fallback). The client's
 * runtime-config virtual module reads these on boot to pick up the
 * resolved wsKey and the NATS/Restate URLs.
 *
 * Idempotent: if the document already contains our marker, the HTML
 * is returned unchanged.
 */
export function injectMetaTags(
    html: string,
    values: { workspaceId: string; natsUrl: string; restateUrl: string; gatewayUrl?: string },
): string {
    if (html.includes(META_MARKER)) return html;

    const meta = [
        `<meta name="syncengine-workspace-id" content="${escapeAttr(values.workspaceId)}">`,
        `<meta name="syncengine-nats-url" content="${escapeAttr(values.natsUrl)}">`,
        `<meta name="syncengine-restate-url" content="${escapeAttr(values.restateUrl)}">`,
        ...(values.gatewayUrl ? [`<meta name="syncengine-gateway-url" content="${escapeAttr(values.gatewayUrl)}">`] : []),
    ].join('\n    ');

    if (html.includes('</head>')) {
        return html.replace('</head>', `    ${meta}\n  </head>`);
    }
    return html.replace('<head>', `<head>\n    ${meta}`);
}

export function escapeAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
