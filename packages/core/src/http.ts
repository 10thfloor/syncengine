// ── HTTP helpers shared between the Vite plugin (dev) and the
// production server (Phase 9). These are pure functions with no
// framework dependencies — only `node:crypto` for hashing.

import { createHash } from 'node:crypto';

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
