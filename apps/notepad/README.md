# notepad

A small collaborative notes app. Demonstrates the *client-facing*
slice of syncengine — tables, views, presence, durable timers, and
inbound webhooks — in an app that's simpler than the kitchen-sink.

Good for:
- Reading end-to-end without getting lost in storefront business logic
- Dogfooding `syncengine init` scaffold conventions (this app *is*
  roughly what the init template produces)
- Feeling presence, heartbeats, and durable sleep side-by-side

## Running locally

From the repo root:

```bash
pnpm install
cd apps/notepad && pnpm dev
```

Or, from the notepad directory:

```bash
pnpm dev
```

Open two browser tabs at `http://localhost:5173/?user=alice` and
`?user=bob`. Type in one, watch notes appear in the other — with
author badges colored deterministically per user. Each tab also
shows up as a peer dot in the presence strip.

## What's in here

| Primitive | File |
|---|---|
| Tables + views | `src/schema.ts` — `notes`, `thumbs`, plus `recentNotes` / `notesByAuthor` / `allThumbs` views |
| Entity (state machine) | `src/entities/focus.actor.ts` — per-user focus session; `idle → running → done` |
| Entity (ingest) | `src/entities/inbox.actor.ts` — server-side entity for inbound webhook payloads |
| Topic | `src/topics/presence.topic.ts` — ephemeral "who's here" |
| Heartbeat | `src/heartbeats/pulse.heartbeat.ts` — durable recurring job, crash-safe across restarts |
| Workflow | `src/workflows/pomodoro.workflow.ts` — durable `ctx.sleep`, calls `focus.finish()` when timer fires |
| Webhook | `src/webhooks/notify.webhook.ts` — inbound HTTP with HMAC signature verification + idempotency |

## Things to try

### Real-time sync

- Two tabs at `?user=alice` + `?user=bob`. Type in either, see both.
- `?workspace=team-a` in the URL isolates state to a tenant scope.

### Durable pomodoro

1. In any tab, type "learning syncengine" in the focus input and
   click **🍅 30s**.
2. While the countdown is running, Ctrl-C `syncengine dev` and
   restart it.
3. Watch the focus entity still transition to `done` on schedule —
   the workflow resumed from its Restate journal.

### Heartbeat restart

1. Click **Start** on the heartbeat strip. It ticks at 5s intervals
   for 12 runs.
2. Mid-run, restart `syncengine dev`. Ticks resume from where they
   left off — `setInterval` would have dropped them.

### Inbound webhook

```bash
echo -n '{"text":"hello from curl","from":"me"}' > /tmp/body.json
SECRET=dev-secret
SIG=$(openssl dgst -sha256 -hmac "$SECRET" -hex < /tmp/body.json | awk '{print $2}')
curl -X POST http://localhost:5173/webhooks/notify \
  -H "content-type: application/json" \
  -H "x-signature: sha256=$SIG" \
  --data-binary @/tmp/body.json
```

A new note appears in the feed. The webhook workflow calls
`inbox.receive(...)` which `emit()`s into the `notes` table, and
every tab materializes the row through the same CRDT pipeline as
a typed note.

Repeat the same request — the `onDuplicate: '409'` policy surfaces
dedup, because the idempotency key is the event id.

## Notes on the code

- Handlers are pure `(state, ...args) => newState`. No `ctx`, no
  `async` — that's deliberate, and enables the optimistic-UI +
  authoritative-server "same function, two call sites" story.
- `syncengine.config.ts` uses the dev-only `unverified()` auth
  adapter so `?user=<id>` stands in for a real bearer token.
  Production: swap for `jwt({ jwksUri, ... })` or similar.
- Everything under `src/components/` is just React — the framework
  is invisible until you look at `db.ts` (the store) and
  `main.tsx` (the `<StoreProvider>`).

## Vs. kitchen-sink

`apps/notepad` demonstrates the client-heavy slice; it's what a new
user builds first. `apps/kitchen-sink` demonstrates everything at
once — bus, subscriber workflows, DLQ, value objects, hex saga
flows — and is where the framework's tests live. Start here,
graduate there.
