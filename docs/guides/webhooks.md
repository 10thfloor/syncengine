# Webhooks Guide

> `webhook()` declares an inbound HTTP endpoint for vendor callbacks
> (GitHub, Stripe, Slack, generic partners). Compiles to a Restate
> workflow keyed on the idempotency key you derive from the request,
> so retries from the sender collapse to one execution and the
> handler inherits Restate's durability.

## When to reach for a webhook

| Primitive | Shape | Use for |
|---|---|---|
| `workflow` | Internal orchestration | Sagas you start from the app. |
| `bus` subscriber | Reacts to internal events | Reactor to domain events. |
| **`webhook`** | **Inbound HTTP from outside** | **Vendor → your app: Stripe charges, GitHub pushes, Slack events.** |

HTTP response is always a fast **202 Accepted**. Work runs async inside the workflow body.

## Five-line declaration

```ts
// src/webhooks/stripe.webhook.ts
import { webhook } from '@syncengine/server';
import { payments } from '../services/payments';

export const stripeEvents = webhook('stripeEvents', {
  path: '/stripe/events',
  verify: { scheme: 'hmac-sha256', secret: () => process.env.STRIPE_SECRET! },
  resolveWorkspace: (p) => p.data.object.customer as string,
  idempotencyKey: (_req, p) => p.id,
  services: [payments],
  run: async (ctx, payload) => {
    if (payload.type === 'charge.succeeded') {
      await ctx.services.payments.recordSuccess(payload.data.object.id);
    }
  },
});
```

Drop under `src/webhooks/` with a `.webhook.ts` suffix. The vite plugin picks it up; boot registers a Restate workflow `webhook_<name>` and an HTTP route at the declared path.

## Verify: request authentication

The `verify` field is **required**. Two shapes:

**Built-in HMAC** (covers GitHub, Shopify, most HMAC-style):
```ts
verify: {
  scheme: 'hmac-sha256',
  secret: () => process.env.GITHUB_SECRET!,  // called per request — env/secret-manager reads OK
  header: 'x-hub-signature-256',             // default: 'x-signature'
  prefix: 'sha256=',                         // strip before compare
  encoding: 'hex',                           // or 'base64'
}
```

**Custom** (vendor-specific like Stripe's `Stripe-Signature`, Slack's `X-Slack-Signature`):
```ts
verify: async (req, rawBody) => {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return { ok: false, reason: 'missing signature' };
  try {
    stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_SECRET!);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}
```

`{ ok: false }` → 401. Custom verifiers own their own error handling.

## Idempotency

`idempotencyKey` derives a stable string from the request — the framework uses it as the Restate workflow invocation id.

```ts
idempotencyKey: (_req, payload) => payload.id,           // Stripe
idempotencyKey: (req, _payload) => req.headers.get('x-github-delivery')!,  // GitHub
```

**Same key → same invocation.** If Stripe retries a webhook because it didn't see the 202, the second delivery reaches the same Restate invocation id — the journal detects it and either returns the first response (default) or fails with a 409 (opt-in).

`onDuplicate`:
- `'409'` (default) — second and subsequent deliveries of a completed invocation get `409 Conflict`. Correct for most webhooks.
- `'200'` — second delivery gets `200 OK`. Use when the sender retries on anything that isn't 2xx (strict senders like some enterprise systems).

## Workspace scoping

Multi-tenant apps run one app process, many workspaces. The webhook needs to know which workspace this event belongs to:

```ts
resolveWorkspace: (payload) => payload.data.object.customer,  // Stripe customer → workspace
resolveWorkspace: (payload) => payload.repository.owner.login, // GitHub org → workspace
```

The framework hashes the return value to a `wsKey` and ensures the workspace is provisioned before invoking the handler.

## The ctx contract

Webhook handlers receive a `WebhookContext` — extends `restate.WorkflowContext` so everything from the workflow guide applies, plus:

| Field | What |
|---|---|
| `ctx.name` | The webhook name (`'stripeEvents'`). |
| `ctx.idempotencyKey` | Whatever `idempotencyKey` returned for this request. |
| `ctx.workspace` | The resolved workspace id. |
| `ctx.headers` | `ReadonlyMap<string, string>` — incoming headers, lower-cased. |
| `ctx.services.<name>` | Typed service-port bag from `services: [...]`. |

Determinism rules identical to workflows — use `ctx.run` for I/O, `ctx.date.now()` for timestamps, etc.

## Footguns

- **`resolveWorkspace` and `idempotencyKey` are synchronous.** No I/O, no `await`. They run on the hot path before the handler even registers as an invocation.
- **HTTP response is always 202** (or 401 on verify fail, 409 on duplicate). The `run` body doesn't control the status code — it runs async.
- **Verify runs on the raw body.** If you parse the body before verify, signature checks break (different whitespace, different encoding). The framework reads raw bytes first, then parses after verify passes.
- **Names must match `/^[a-zA-Z][a-zA-Z0-9_]*$/`** and be unique across the app. Path must start with `/` and contain only `[a-zA-Z0-9/_-]`.
- **`onDuplicate: '200'`** replays the original response body. If your handler was non-deterministic on its first run, the second sender sees stale output — ensure determinism even in the handler's response path.

## Pairs with

- **Services** — vendor SDKs live in services so tests can swap them.
- **Entities** — durable calls via `entityRef(ctx, entity, key).method(...)`.
- **Bus** — the handler can `bus.publish(ctx, ...)` to fan out domain events (e.g. "chargeSucceeded" event consumed by multiple reactors).

## Testing

Integration test via the bus harness pattern isn't a direct fit — webhooks come in over HTTP. For unit testing the handler body, call it with a mock ctx carrying the `services` bag; for integration, drive the actual HTTP endpoint with a signed request.

## Links

- Spec: `docs/superpowers/specs/2026-04-19-webhook-primitive.md`
- Server code: `packages/server/src/webhook.ts`, `webhook-http.ts`, `webhook-verify.ts`
