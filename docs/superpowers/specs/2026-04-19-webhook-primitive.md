# Webhook Primitive

**Date:** 2026-04-19
**Status:** Draft
**Scope:** New framework primitive — `@syncengine/server`, `@syncengine/vite-plugin`, production `serve.ts`

## Summary

Add `webhook(name, config)` as a first-class framework primitive alongside `table`, `entity`, `topic`, `heartbeat`, and `defineWorkflow`. A webhook is an inbound HTTP POST endpoint designed for *external services* (Stripe, GitHub, Slack, Twilio, custom partners) to notify the app of events. File-based discovery (`*.webhook.ts`), compiles to a Restate workflow so the handler inherits durable execution, retry, and idempotency dedup — the things every production webhook needs.

One built-in verification scheme in v1 (`hmac-sha256`, the lowest common denominator covering GitHub, generic partners, and anything Shopify-style). Custom vendor schemes (Stripe, Slack, etc.) go through an escape-hatch `verify` function the user provides, with no framework support required to ship a new vendor.

## Context: webhooks vs. API endpoints

The app already has two HTTP surfaces: the browser-facing entity/workflow RPC proxies (`/__syncengine/rpc/...`) and the production static-HTML server. Both assume a trusted browser client and a workspace header.

A webhook inverts three of those assumptions:

- **Caller is untrusted until HMAC-verified.** No session, no cookie, no user. Only payload + signature.
- **Workspace has to be derived from the payload.** The external service doesn't know or care about syncengine's workspace model; the user's `resolveWorkspace` callback maps the payload fields (e.g. `metadata.workspaceId`, `customerId`) to a wsKey.
- **The response is a 2xx within seconds, not a computed result.** External services retry on any non-2xx and give up after N attempts. Long work must happen durably *after* the 2xx.

That third bullet is why compiling to a Restate workflow is the right baseline: we ack the HTTP fast, the handler runs durably, and Restate dedups repeat invocations with the same idempotency key.

## Goals

- Declarative inbound HTTP endpoints with framework-managed verification, idempotency, and durable processing.
- **One built-in verification scheme (`hmac-sha256`)** covering the common HMAC-over-body case plus enough config knobs for GitHub, Shopify, and similar.
- **Escape hatch** for custom vendor schemes (Stripe's timestamped HMAC, Slack's signed secret + timestamp, Twilio's X-Twilio-Signature, etc.) via a user-supplied async `verify` function.
- File-based discovery matching `.actor.ts` / `.workflow.ts` / `.heartbeat.ts` conventions.
- Response contract external senders can rely on: fast 2xx on accept, explicit 409 on dedup'd retry, explicit 401 on bad signature.

## Non-Goals (v1)

- Vendor-branded built-ins beyond `hmac-sha256`. `verify: { scheme: 'stripe' }`, `'slack'`, `'github'` are v2 candidates once we see real usage; shipping them prematurely means maintaining five half-correct verifiers.
- Webhook registration / management UI. Users still tell Stripe/GitHub the URL themselves.
- Reply bodies richer than `{ ok, invocationId? }`. External services don't read them.
- Non-JSON payloads. The initial parser assumes `content-type: application/json`.
- Outbound webhooks (firing webhooks TO external services). That's a different primitive — probably a small `ctx.run` helper inside a workflow.

## Mental model

`webhook('name', config)` creates a **definition**. The runtime:

1. Registers an HTTP route at `/webhooks/<config.path>` on the production server and the Vite dev middleware.
2. Compiles the handler to a Restate workflow named `webhook_<name>`.
3. On each inbound POST: parses body → verifies signature → resolves workspace + idempotency key → invokes the Restate workflow with the idempotency key → returns 2xx.

Restate's workflow-per-key dedup IS the idempotency mechanism: repeating a request with the same idempotency key hits an existing workflow invocation, Restate recognizes the duplicate, no work re-runs.

## API surface

### Minimum useful webhook

```typescript
// src/webhooks/github-push.webhook.ts
import { webhook, entityRef } from '@syncengine/server';
import { builds } from '../schema';

export const githubPush = webhook('githubPush', {
  path: '/github/push',
  verify: {
    scheme: 'hmac-sha256',
    secret: () => process.env.GITHUB_WEBHOOK_SECRET!,
    header: 'x-hub-signature-256',
    prefix: 'sha256=',
    encoding: 'hex',
  },
  resolveWorkspace: (payload) => String(payload.repository?.full_name ?? 'default'),
  idempotencyKey: (req) => req.headers['x-github-delivery']!,
  run: async (ctx, payload) => {
    await entityRef(ctx, build, String(payload.after)).start(payload);
  },
});
```

### Full config shape

```typescript
interface WebhookConfig<TPayload = unknown> {
  /** URL segment appended to `/webhooks`. */
  path: string;

  /** Signature verification — built-in scheme or a custom async function. */
  verify: HmacVerifyConfig | CustomVerifyFn;

  /** Map the incoming payload to a workspace id (becomes the Restate key
   *  prefix). The framework hashes this to a wsKey. Return a stable string. */
  resolveWorkspace: (payload: TPayload) => string;

  /** Extract the idempotency key (Restate workflow invocation id) from
   *  the incoming request. Must be stable across retries of the same
   *  logical event. Most vendors provide an event id header. */
  idempotencyKey: (req: Request, payload: TPayload) => string;

  /** Durable handler — runs inside a Restate workflow context. */
  run: (ctx: WebhookContext, payload: TPayload) => Promise<void>;
}

interface HmacVerifyConfig {
  readonly scheme: 'hmac-sha256';
  readonly secret: () => string;
  /** HTTP header carrying the digest. Default: 'x-signature'. */
  readonly header?: string;
  /** Optional prefix stripped before comparing (e.g. 'sha256='). */
  readonly prefix?: string;
  /** How the digest is encoded in the header. Default: 'hex'. */
  readonly encoding?: 'hex' | 'base64';
}

type CustomVerifyFn = (req: Request, rawBody: string) => Promise<VerifyResult>;

type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
```

### Handler context

```typescript
interface WebhookContext extends restate.WorkflowContext {
  readonly name: string;
  readonly idempotencyKey: string;
  readonly workspace: string;
  /** Raw request headers at the time of receipt (read-only). Useful for
   *  routing decisions that depend on e.g. GitHub's `x-github-event`. */
  readonly headers: ReadonlyMap<string, string>;
}
```

All Restate context primitives are available: `ctx.sleep`, `ctx.run`, `ctx.date.now`, `entityRef`, `workflowClient`.

### Custom verify example (Stripe-style, user-owned)

```typescript
export const stripePayment = webhook('stripePayment', {
  path: '/stripe/payments',
  verify: async (req, rawBody) => {
    // Stripe: "t=<timestamp>,v1=<hmac>" in Stripe-Signature header
    const sig = req.headers.get('stripe-signature') ?? '';
    const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=')));
    if (!parts.t || !parts.v1) return { ok: false, reason: 'missing t/v1' };
    const signed = `${parts.t}.${rawBody}`;
    const expected = await hmacSha256(process.env.STRIPE_SECRET!, signed);
    return expected === parts.v1 ? { ok: true } : { ok: false, reason: 'bad digest' };
  },
  resolveWorkspace: (payload) => String(payload.data.object.metadata.workspaceId),
  idempotencyKey: (req) => req.headers.get('stripe-signature')!,  // Or payload.id
  run: async (ctx, payload) => { /* ... */ },
});
```

Users wire this however their vendor documents. The framework stays out of the way for vendor-specific schemes.

## Verification: the `hmac-sha256` scheme

Covers all of:

- Simple shared-secret HMAC (custom partners, generic platforms).
- GitHub (`x-hub-signature-256`, `sha256=<hex>`).
- Shopify (`x-shopify-hmac-sha256`, base64).
- Any vendor whose auth is "here's the HMAC of the raw body using this secret."

Procedure:

1. Read the configured `header`.
2. Strip `prefix` if present; if absent but the header starts with `<scheme>=`, strip that silently.
3. Decode per `encoding` (`hex` or `base64`).
4. Compute `HMAC-SHA256(secret, rawBody)` via Node's `crypto.createHmac` (not webcrypto — Node-side only; see Non-Goals for Edge).
5. Constant-time compare with `crypto.timingSafeEqual`. Return 401 on mismatch.

Reject early — no body parsing, no workspace resolution — if the header is missing or decode fails. This is the hot path; cheapness matters.

## Idempotency contract

Restate assigns each workflow invocation a unique `(workflow, key)` identity. The framework uses `idempotencyKey(req, payload)` as the `key` part. Semantics:

- **First invocation with a given key** — workflow starts, runs to completion.
- **Retry with the same key** while in-flight — Restate rejects with "already running." Framework returns `202` with the existing invocation id.
- **Retry with the same key** after completion — Restate rejects with "already completed." Framework returns `409 Conflict` with `{ ok: true, duplicate: true, invocationId }`. External senders that retry on non-2xx should be configured to treat 409 as success; for strict senders that only trust 2xx, the user can override to 200 (see Footguns).

Idempotency keys MUST be stable across sender retries of the same logical event. Sender-provided event ids (GitHub's `x-github-delivery`, Stripe's event `id`, the Stripe-Signature header verbatim) are the right choice. Per-request nonces are the wrong choice.

## Response contract

| Status | When | Body |
|---|---|---|
| `202 Accepted` | First receipt, workflow invoked | `{ ok: true, invocationId }` |
| `401 Unauthorized` | Signature verification failed | `{ ok: false, reason }` |
| `400 Bad Request` | Body not JSON, missing required fields, config-time error | `{ ok: false, reason }` |
| `409 Conflict` | Idempotency key already processed to completion | `{ ok: true, duplicate: true, invocationId }` |
| `5xx` | Framework / Restate unavailable | `{ ok: false, reason }` |

Handler errors *do not* propagate to the HTTP response. The workflow owns the failure: it retries internally (via Restate's journaled retry), records errors via a framework-managed status entity (see below), and the external sender has long since received a 202.

## Workflow compilation

Each webhook compiles to a Restate workflow named `webhook_<name>` with one handler `run`. Body skeleton:

```typescript
export function buildWebhookWorkflow(def: WebhookDef, handler: WebhookHandler) {
  return defineWorkflow(`webhook_${def.name}`, async (ctx, input: WebhookInvocation) => {
    // 1. Record receipt in status entity (for observability / devtools).
    const status = entityRef(ctx, webhookStatus, `${def.name}/${input.idempotencyKey}`);
    await status.receive(ctx.date.now(), input.workspace);

    // 2. Run user handler with a wrapped context.
    const webhookCtx = buildWebhookContext(ctx, def, input);
    try {
      await handler(webhookCtx, input.payload);
      await status.complete(await ctx.date.now());
    } catch (err) {
      await status.fail(await ctx.date.now(), formatErr(err));
      throw err; // Let Restate retry per its retry policy.
    }
  });
}
```

The status entity (framework-owned, parallel to `heartbeatStatus`) tracks `{ receivedAt, completedAt, failedAt, errorCount, lastError }` keyed on `${name}/${idempotencyKey}`. Exposed to the UI via a future `useWebhookStatus(def, key)` hook.

## Routing

Webhooks mount at `/webhooks/<config.path>`. The framework reserves the `/webhooks` prefix; user apps cannot shadow it. Examples:

- `path: '/github/push'` → `POST /webhooks/github/push`
- `path: '/stripe/payments'` → `POST /webhooks/stripe/payments`

No per-workspace URL variants in v1 — the workspace is derived from the payload, not the URL. If multi-tenant URL scoping becomes necessary (e.g. per-customer GitHub apps), we add `workspaceInUrl: true` in v2.

## Discovery

Files matching `src/**/*.webhook.ts` are auto-discovered by:

1. `@syncengine/server`'s `loadDefinitions` (same path as `.actor.ts` / `.workflow.ts` / `.heartbeat.ts`).
2. `@syncengine/vite-plugin`'s client-side stubbing — webhooks are server-only, so the client bundle gets an empty stub for each file (same pattern as `.workflow.ts`).

## Footguns

| Footgun | Handling |
|---|---|
| User forgets `verify` | Build-time error at discovery. `verify` is a required field. |
| User picks a non-stable idempotency key (e.g. `Date.now()`) | Per-request nonce defeats dedup; external retries re-run the handler. Documentation + lint-grade suggestion in the factory (if we detect obvious anti-patterns, log warning at registration). |
| Handler sends non-idempotent side effects outside `ctx.run` | Restate replays the handler on retry; side effects re-fire. Standard Restate discipline applies; document clearly. |
| 409 breaks senders that only trust 2xx | Allow `onDuplicate: '200' \| '409'` config override (default 409 for clarity, 200 for strict senders). |
| Raw body mutations between verify and handler | Framework captures `rawBody: string` once, passes it to verify, then parses for the handler. No mutation path exists. |
| Large payloads (Slack sends up to ~1MB events) | Hard cap 5 MiB on webhook bodies; reject larger with 413. Configurable per webhook if a vendor genuinely needs more. |
| Webhook arrives before workspace is provisioned | `ensureProvisioned(wsKey)` in the HTTP handler before invoking the workflow, same path production static server already uses for HTML requests. |
| Sender IP allowlisting | Not in v1. Users who need it add a tiny middleware themselves; framework-managed IP lists require upkeep we're not signing up for. |
| Replay attacks using captured signed requests | `hmac-sha256` scheme has no timestamp; `verify: custom` users add timestamp skew checks themselves (Stripe/Slack patterns include this). Generic HMAC users accept this tradeoff or wrap in a custom verify. |

## Scope

### v1 — in this spec

- `webhook(name, config)` factory + file discovery.
- Built-in `scheme: 'hmac-sha256'` verifier (header, prefix, encoding options).
- Custom `verify: (req, rawBody) => Promise<VerifyResult>` escape hatch.
- Compile to one Restate workflow per webhook; `run` handler receives `WebhookContext`.
- Framework-owned `webhookStatus` entity for receipt tracking.
- Request shape: JSON POST at `/webhooks/<path>`, 5 MiB body limit, `content-type: application/json`.
- Response contract: 202 / 409 / 401 / 400 / 5xx as specified.
- Dev middleware (`@syncengine/vite-plugin`) and production server (`@syncengine/server/serve`) both route `/webhooks/*` through the same handler chain.

### Deferred (v2 candidates)

- Vendor-branded built-in verifiers — `scheme: 'stripe' | 'slack' | 'twilio' | 'github'` with opinionated defaults. Revisit once three real users ask for each.
- Non-JSON content types (`application/x-www-form-urlencoded`, `multipart/form-data`).
- `workspaceInUrl: true` — per-workspace URL variants.
- Rate limiting at the framework level.
- `useWebhookStatus(def, key)` client hook.
- Outbound webhooks (firing to external services from handlers) — separate primitive.
- CLI helper to test-fire a webhook locally (`syncengine webhook test <name> --payload fixture.json`).

### Rejected

- Automatic retry orchestration beyond what Restate provides. Restate's workflow retry is sufficient and well-understood.
- Cross-webhook dependencies / chaining. Use workflows that invoke each other.
- Framework-managed secret rotation. Users rotate secrets via `secret: () => process.env.SECRET_VERSION_N` and a deploy.

## Rollout plan

Each step is independently ship-able.

1. **Core types + factory** — `packages/server/src/webhook.ts`. `WebhookDef`, `webhook()`, inline validation, discovery tag.
2. **Built-in `hmac-sha256` verifier** — `packages/server/src/webhook-verify.ts` with a single exported function + a custom-verifier dispatch wrapper.
3. **`webhookStatus` entity** — `packages/core/src/webhook-status.ts` (in core so client-side hooks can import without node-only deps).
4. **Loader discovery** — extend `loadDefinitions` to scan `*.webhook.ts`.
5. **Vite plugin client stub** — extend `actors.ts` to replace `.webhook.ts` with `{ $tag: 'webhook', $name, $path }` stubs.
6. **HTTP handler** — shared between `@syncengine/vite-plugin` dev middleware and `@syncengine/server/serve`. Parses body, verifies, POSTs to the workflow endpoint with the idempotency key.
7. **Workflow compilation** — `buildWebhookWorkflow(def)` + endpoint binding in `startRestateEndpoint`.
8. **Scaffold example** — `syncengine init` emits `src/webhooks/echo.webhook.ts` demonstrating `hmac-sha256` + a trivial `run` handler that writes a row. Documents the test recipe (`curl` with an HMAC'd body).

Steps 1–7 are the MVP. Step 8 makes the primitive visible in the scaffold.

## Appendix: why not just expose `route()`?

An alternate design: ship a generic `route(name, handler)` primitive and let users layer verification, dedup, and workflow compilation themselves. Considered and rejected because:

- **Idempotency + durability are the critical wiring**, not the HTTP surface. A generic route lets users build webhooks that drop events on server restart; that's the #1 bug in every hand-rolled webhook integration.
- **The opinionated path is 80% of what people need.** Generic routing can come later; it's strictly easier to add escape hatches than to take back default behaviors.
- **Verification-by-scheme is a tiny layer** (~80 lines including tests) compared to the durable-workflow wiring. Not worth the framework maintenance saved by punting it.

If there's demand for non-webhook inbound routes (raw HTTP for things like OAuth callbacks, static file endpoints, etc.), `route()` becomes its own primitive later with different defaults — stateless, non-durable, sync reply.
