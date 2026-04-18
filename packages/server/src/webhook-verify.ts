// ── Webhook signature verification ──────────────────────────────────────────
//
// One built-in scheme ('hmac-sha256'); custom schemes go through the
// user-supplied async function in the webhook config.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HmacVerifyConfig, VerifyConfig, VerifyResult } from './webhook.js';

/**
 * Run the configured verifier against a request. Constant-time
 * comparison for the built-in scheme; custom schemes get the raw
 * body and Request so they can implement Stripe/Slack/Twilio-style
 * timestamped-HMAC patterns themselves.
 */
export async function runVerify(
    verify: VerifyConfig,
    req: Request,
    rawBody: string,
): Promise<VerifyResult> {
    if (typeof verify === 'function') {
        return verify(req, rawBody);
    }
    return verifyHmacSha256(verify, req, rawBody);
}

function verifyHmacSha256(
    cfg: HmacVerifyConfig,
    req: Request,
    rawBody: string,
): VerifyResult {
    const headerName = cfg.header ?? 'x-signature';
    const raw = req.headers.get(headerName);
    if (!raw) return { ok: false, reason: `missing ${headerName} header` };

    // Strip prefix. Accept both the configured prefix and the
    // default 'sha256=' / 'hmac-sha256=' so senders that quietly
    // add one still verify.
    const prefixes = [cfg.prefix, 'sha256=', 'hmac-sha256='].filter((p): p is string => !!p);
    let provided = raw;
    for (const p of prefixes) {
        if (provided.startsWith(p)) { provided = provided.slice(p.length); break; }
    }

    const encoding = cfg.encoding ?? 'hex';
    let providedBuf: Buffer;
    try {
        providedBuf = Buffer.from(provided, encoding);
    } catch {
        return { ok: false, reason: `bad ${encoding} encoding in header` };
    }

    const secret = cfg.secret();
    const expectedBuf = createHmac('sha256', secret).update(rawBody, 'utf8').digest();

    if (providedBuf.length !== expectedBuf.length) {
        return { ok: false, reason: 'digest length mismatch' };
    }
    if (!timingSafeEqual(providedBuf, expectedBuf)) {
        return { ok: false, reason: 'digest mismatch' };
    }
    return { ok: true };
}
