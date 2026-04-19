// ── Webhook primitive ───────────────────────────────────────────────────────
//
// `webhook(name, config)` declares an inbound HTTP endpoint for external
// services (GitHub, Stripe, Slack, generic partners). Compiles to a
// Restate workflow keyed on the user-provided idempotencyKey so:
//   - repeat deliveries from the sender collapse to one execution
//   - the handler's durability inherits from Restate (crashes survive)
//   - the HTTP response is a fast 202, work runs async
//
// See docs/superpowers/specs/2026-04-19-webhook-primitive.md for the
// full design, verification-scheme contract, and footgun analysis.

import * as restate from '@restatedev/restate-sdk';
import { errors, SchemaCode } from '@syncengine/core';
import type { AnyService } from '@syncengine/core';

// ── Public types ────────────────────────────────────────────────────────────

/** Built-in HMAC-SHA256 verification. Covers GitHub-style
 *  `sha256=<hex>` headers, Shopify's base64, and generic HMAC. */
export interface HmacVerifyConfig {
    readonly scheme: 'hmac-sha256';
    readonly secret: () => string;
    /** HTTP header carrying the digest. Default: 'x-signature'. */
    readonly header?: string;
    /** Optional prefix stripped before comparing (e.g. 'sha256='). */
    readonly prefix?: string;
    /** How the digest is encoded in the header. Default: 'hex'. */
    readonly encoding?: 'hex' | 'base64';
}

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Escape hatch for vendor-specific schemes (Stripe, Slack, Twilio, etc.). */
export type CustomVerifyFn = (req: Request, rawBody: string) => Promise<VerifyResult>;

export type VerifyConfig = HmacVerifyConfig | CustomVerifyFn;

export interface WebhookContext extends restate.WorkflowContext {
    readonly name: string;
    readonly idempotencyKey: string;
    readonly workspace: string;
    /** Request headers at the time of receipt (lower-cased names). */
    readonly headers: ReadonlyMap<string, string>;
}

export type WebhookHandler<TPayload = unknown> = (
    ctx: WebhookContext,
    payload: TPayload,
) => Promise<void>;

export interface WebhookConfig<TPayload = unknown> {
    /** URL path appended to `/webhooks`. */
    path: string;
    verify: VerifyConfig;
    /** Derive the workspace id from the incoming payload. Framework
     *  hashes the return value to a wsKey and ensures it's provisioned. */
    resolveWorkspace: (payload: TPayload) => string;
    /** Derive the Restate workflow invocation id — stable across
     *  sender retries of the same logical event. */
    idempotencyKey: (req: Request, payload: TPayload) => string;
    /** Behavior when a duplicate idempotency key is received after
     *  completion. Default 409. Some strict senders only accept 2xx. */
    onDuplicate?: '200' | '409';
    /** Services required by this webhook handler. */
    readonly services?: readonly AnyService[];
    run: WebhookHandler<TPayload>;
}

export interface WebhookDef<TName extends string = string> {
    readonly $tag: 'webhook';
    readonly $name: TName;
    readonly $path: string;
    readonly $verify: VerifyConfig;
    readonly $resolveWorkspace: (payload: unknown) => string;
    readonly $idempotencyKey: (req: Request, payload: unknown) => string;
    readonly $onDuplicate: '200' | '409';
    readonly $services: readonly AnyService[];
    readonly $handler: WebhookHandler;
}

export const WEBHOOK_WORKFLOW_PREFIX = 'webhook_';

// ── Factory ─────────────────────────────────────────────────────────────────

export function isWebhook(value: unknown): value is WebhookDef {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>).$tag === 'webhook'
    );
}

export function webhook<const TName extends string, TPayload = unknown>(
    name: TName,
    config: WebhookConfig<TPayload>,
): WebhookDef<TName> {
    validateName(name);
    validatePath(config.path, name);
    validateVerify(config.verify, name);
    validateHandlers(config as unknown as WebhookConfig<unknown>, name);

    return {
        $tag: 'webhook',
        $name: name,
        $path: normalizePath(config.path),
        $verify: config.verify,
        $resolveWorkspace: config.resolveWorkspace as (p: unknown) => string,
        $idempotencyKey: config.idempotencyKey as (r: Request, p: unknown) => string,
        $onDuplicate: config.onDuplicate ?? '409',
        $services: config.services ?? [],
        $handler: config.run as WebhookHandler,
    };
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateName(name: string): void {
    if (!name || typeof name !== 'string') {
        throw errors.schema(SchemaCode.INVALID_WEBHOOK_NAME, {
            message: `webhook: name must be a non-empty string.`,
            hint: `Pass a valid name: webhook('myWebhook', { ... })`,
        });
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw errors.schema(SchemaCode.INVALID_WEBHOOK_NAME, {
            message: `webhook('${name}'): name must match /^[a-zA-Z][a-zA-Z0-9_]*$/.`,
            hint: `Use only letters, numbers, and underscores. Must start with a letter.`,
            context: { webhook: name },
        });
    }
}

function validatePath(path: string, name: string): void {
    if (typeof path !== 'string' || path.length === 0) {
        throw errors.schema(SchemaCode.INVALID_WEBHOOK_CONFIG, {
            message: `webhook('${name}'): path must be a non-empty string.`,
            hint: `Pass a path: webhook('${name}', { path: '/stripe/payments', ... })`,
            context: { webhook: name },
        });
    }
    if (!/^\/[a-zA-Z0-9/_-]+$/.test(path)) {
        throw errors.schema(SchemaCode.INVALID_WEBHOOK_CONFIG, {
            message: `webhook('${name}'): path '${path}' must start with '/' and contain only [a-zA-Z0-9/_-].`,
            hint: `Example: '/github/push'.`,
            context: { webhook: name, path },
        });
    }
}

function validateVerify(verify: VerifyConfig, name: string): void {
    if (typeof verify === 'function') return; // custom verifier — user's responsibility

    if (typeof verify !== 'object' || verify === null || verify.scheme !== 'hmac-sha256') {
        throw errors.schema(SchemaCode.INVALID_WEBHOOK_CONFIG, {
            message: `webhook('${name}'): verify must be { scheme: 'hmac-sha256', ... } or a custom async function.`,
            hint: `Built-in scheme: { scheme: 'hmac-sha256', secret: () => process.env.SECRET! }.`,
            context: { webhook: name },
        });
    }
    if (typeof verify.secret !== 'function') {
        throw errors.schema(SchemaCode.INVALID_WEBHOOK_CONFIG, {
            message: `webhook('${name}'): verify.secret must be a function returning the HMAC secret.`,
            hint: `e.g. secret: () => process.env.WEBHOOK_SECRET!`,
            context: { webhook: name },
        });
    }
    if (verify.encoding && verify.encoding !== 'hex' && verify.encoding !== 'base64') {
        throw errors.schema(SchemaCode.INVALID_WEBHOOK_CONFIG, {
            message: `webhook('${name}'): verify.encoding must be 'hex' or 'base64' (got '${verify.encoding}').`,
            context: { webhook: name, encoding: verify.encoding },
        });
    }
}

function validateHandlers(config: WebhookConfig<unknown>, name: string): void {
    for (const key of ['resolveWorkspace', 'idempotencyKey', 'run'] as const) {
        if (typeof config[key] !== 'function') {
            throw errors.schema(SchemaCode.INVALID_WEBHOOK_CONFIG, {
                message: `webhook('${name}'): '${key}' must be a function.`,
                context: { webhook: name, field: key },
            });
        }
    }
}

function normalizePath(p: string): string {
    return p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p;
}
