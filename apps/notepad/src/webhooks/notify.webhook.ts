import { webhook, entityRef } from "@syncengine/server";
import { inbox } from "../entities/inbox.actor";

/**
 * Webhooks are the primitive for inbound HTTP from external services:
 * GitHub/Stripe/Slack, vendor partners, or a curl from your laptop.
 * Each `webhook()` compiles to a Restate workflow keyed on the
 * user-supplied `idempotencyKey`. That gives you four things for free:
 *
 *   - Signature verification before any body parsing (see `verify`).
 *   - Workflow-per-key deduplication — repeat deliveries from the same
 *     event id collapse to one handler execution, even across retries.
 *   - Durable execution — the handler inherits Restate's journal so
 *     crashes mid-flight resume where they left off.
 *   - Fast ack — the HTTP response is a 202 as soon as the workflow is
 *     scheduled; the handler runs async.
 *
 * Try it locally — the dev server exposes this at `POST /webhooks/notify`:
 *
 *   echo -n '{"text":"hello from curl","from":"me"}' > /tmp/body.json
 *   SECRET=dev-secret
 *   SIG=$(openssl dgst -sha256 -hmac "$SECRET" -hex < /tmp/body.json | awk '{print $2}')
 *   curl -X POST http://localhost:5173/webhooks/notify \
 *     -H "content-type: application/json" \
 *     -H "x-signature: sha256=$SIG" \
 *     --data-binary @/tmp/body.json
 *
 * A new note appears in the feed instantly — the webhook handler calls
 * the `inbox` entity which `emit()`s a row into the `notes` table,
 * which syncs to every connected client through the same NATS + DBSP
 * pipeline as your own typed notes.
 *
 * Production note: replace `() => 'dev-secret'` with a real secret
 * from your env (`() => process.env.NOTIFY_SECRET!`) before shipping.
 */
interface NotifyPayload {
  text: string;
  from?: string;
}

export const notify = webhook<"notify", NotifyPayload>("notify", {
  path: "/notify",

  verify: {
    scheme: "hmac-sha256",
    // Change to `() => process.env.NOTIFY_SECRET!` when you wire this to
    // a real sender. For custom schemes (Stripe, Slack timestamped HMAC,
    // Twilio), pass an async function `(req, rawBody) => ...` instead.
    secret: () => "dev-secret",
    header: "x-signature",
  },

  // Every workspace's data is isolated. Pick something from the payload
  // the sender can stamp; here we just use the configured default so
  // curl against `/webhooks/notify` lands in the current workspace.
  resolveWorkspace: () => "default",

  // Idempotency key = the sender's event id. Repeat deliveries with the
  // same value dedupe. Here we fall back to the request id header so
  // curl-from-the-shell still works while iterating.
  idempotencyKey: (req, payload) => {
    return (
      req.headers.get("x-event-id") ?? `notify-${payload.text}-${Date.now()}`
    );
  },

  // Duplicate-response policy. Some senders treat non-2xx as failure
  // and retry forever; flip to '200' for those. Default '409' makes the
  // dedup visible while debugging.
  onDuplicate: "409",

  run: async (ctx, payload) => {
    const author = payload.from ?? "webhook";
    const body = `[notify] ${payload.text}`;

    // Fan out to the inbox entity — one instance per workspace, stable
    // key so the counter accumulates across events. `entityRef` lifts
    // the workspace id out of the workflow's own key automatically.
    const inboxRef = entityRef(ctx, inbox, "main");
    await inboxRef.receive(body, author, Date.now());
  },
});
