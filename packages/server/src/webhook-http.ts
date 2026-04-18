// ── Webhook HTTP dispatch ───────────────────────────────────────────────────
//
// Shared between the Vite dev middleware and the production HTTP server.
// Takes a received POST + raw body + the loaded webhook definitions and
// returns a Response-shaped result describing what to send back. No
// framework glue — pure request → response contract.

import { hashWorkspaceId } from '@syncengine/core/http';
import { runVerify } from './webhook-verify.js';
import type { WebhookDef } from './webhook.js';
import { WEBHOOK_WORKFLOW_PREFIX } from './webhook.js';

export interface WebhookDispatchResult {
    readonly status: number;
    readonly body: string;
    readonly contentType?: string;
}

/** Match an incoming pathname against the registered webhooks. Returns
 *  null when the pathname isn't under `/webhooks/…` or no def matches. */
export function findWebhook(
    pathname: string,
    defs: readonly WebhookDef[],
): WebhookDef | null {
    if (!pathname.startsWith('/webhooks')) return null;
    const suffix = pathname.slice('/webhooks'.length) || '/';
    return defs.find((d) => d.$path === suffix) ?? null;
}

/** Body size cap. Slack tops out around 1 MiB; Shopify can spike higher
 *  on image uploads. 5 MiB is conservative; bump in the handler if you
 *  know your sender sends bigger. */
export const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Full webhook dispatch: verify signature → parse JSON → resolve
 * workspace + idempotency key → POST to the compiled Restate workflow.
 * Callers are responsible for reading the raw body (different in
 * Connect middleware vs raw Node http) and writing the response.
 */
export async function dispatchWebhook(
    def: WebhookDef,
    req: Request,
    rawBody: string,
    restateUrl: string,
): Promise<WebhookDispatchResult> {
    if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
        return error(413, 'request body exceeds 5 MiB limit');
    }

    // 1. Signature verification — fail fast, no body parsing on bad sig.
    let verified;
    try {
        verified = await runVerify(def.$verify, req, rawBody);
    } catch (e) {
        return error(500, `verify threw: ${(e as Error).message}`);
    }
    if (!verified.ok) {
        return error(401, verified.reason);
    }

    // 2. Parse body.
    let payload: unknown;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return error(400, 'body is not valid JSON');
    }

    // 3. Derive workspace + idempotency key via user callbacks.
    let workspace: string;
    let idempotencyKey: string;
    try {
        workspace = String(def.$resolveWorkspace(payload));
        idempotencyKey = String(def.$idempotencyKey(req, payload));
    } catch (e) {
        return error(400, `resolver threw: ${(e as Error).message}`);
    }
    if (!workspace) return error(400, 'resolveWorkspace returned empty string');
    if (!idempotencyKey) return error(400, 'idempotencyKey returned empty string');

    const wsKey = hashWorkspaceId(workspace);

    // 4. Forward all incoming headers so the handler can inspect them
    //    (common: x-github-event, x-shopify-topic, etc).
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });

    // 5. Invoke the compiled Restate workflow. Key = `{wsKey}/{idemKey}`
    //    so dedup is scoped per workspace AND per sender event id.
    const base = restateUrl.replace(/\/+$/, '');
    const wfKey = `${wsKey}/${idempotencyKey}`;
    const url = `${base}/${WEBHOOK_WORKFLOW_PREFIX}${def.$name}/${encodeURIComponent(wfKey)}/run`;
    const body = JSON.stringify({
        workspace: wsKey,
        idempotencyKey,
        payload,
        headers,
    });

    try {
        const upstream = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
        });
        if (upstream.ok) {
            return ok(202, { ok: true, invocationId: idempotencyKey });
        }
        // Restate signals duplicate invocations with 409 or an "already
        // completed" message in the body. Map to the user's onDuplicate
        // preference; default 409 with duplicate: true so the sender
        // knows it was a retry.
        const text = await upstream.text().catch(() => '<no body>');
        if (upstream.status === 409 || /already (completed|running)/i.test(text)) {
            const status = def.$onDuplicate === '200' ? 200 : 409;
            return ok(status, { ok: true, duplicate: true, invocationId: idempotencyKey });
        }
        return error(502, `restate ${upstream.status}: ${text.slice(0, 200)}`);
    } catch (e) {
        return error(502, `fetch to Restate failed: ${(e as Error).message}`);
    }
}

function ok(status: number, body: Record<string, unknown>): WebhookDispatchResult {
    return {
        status,
        body: JSON.stringify(body),
        contentType: 'application/json',
    };
}

function error(status: number, reason: string): WebhookDispatchResult {
    return {
        status,
        body: JSON.stringify({ ok: false, reason }),
        contentType: 'application/json',
    };
}
