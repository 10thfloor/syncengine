# Stream Regression Detection and Auto-Rebase

**Date:** 2026-04-17
**Status:** Draft
**Scope:** Framework-level — `@syncengine/client` worker + worker↔main protocol, with an optional interception hook on the `Store` API

## Summary

Detect when the authoritative JetStream log for a workspace has regressed relative to what this client has already processed, and automatically reconcile the client's local OPFS + DBSP state to match. Today, a server-side wipe (`syncengine dev --fresh`, workspace delete, destructive migration, GDPR erasure) leaves the client rendering stale rows from its local cache — those rows point at parent records that no longer exist server-side, which silently creates integrity bugs (dangling foreign keys, failing entity handlers, cross-tab data divergence).

Default behavior: **truncate local state and re-materialize from the new stream**, with a `store.serverRewound` event app authors can intercept to override.

## Context: where JetStream fits

Three storage layers, one authoritative log:

- **JetStream stream per workspace** — durable, ordered, replayable. Every table write becomes an event here. This is the source of truth for "what happened in this workspace." Multi-writer fan-out, history for new joiners, and HLC-anchored ordering all depend on it.
- **OPFS SQLite per client** — a projection of the subset of the JetStream log this client cares about. Persistent across refreshes; keyed per-workspace.
- **DBSP materialization per client** — incremental views computed from the OPFS table contents. Re-derived from the underlying tables; no independent durability.

The OPFS store is a **projection**, not an **authority**. It's only valid relative to the stream it was built from. When that stream disappears (or rolls back), the projection is stale in a way it cannot self-correct. That's the gap this spec closes.

## Goals

- **Automatic detection** of stream regression on every resume/reconnect of a workspace subscription, with no app involvement required.
- **Default-safe reconciliation:** truncate-and-rebuild. The user sees the authoritative server state, with a brief "syncing" indicator during the rebuild.
- **Optional interception hook** for apps that want custom policy (preserve local writes, show a confirm dialog, replay-and-merge, etc.).
- **Work across refresh, reconnect, workspace-switch, and cold-start.** The client's ack cursor and stream identity are persisted in OPFS.

## Non-Goals

- **Entity state reconciliation.** Entities live in Restate, not JetStream. Their state is server-owned; the client reads it via live broadcasts. When Restate is wiped, entity state naturally returns to initial values — no local reconciliation needed.
- **Reconciling topic history.** Topics are ephemeral. No log, no divergence.
- **Partial reconciliation** (e.g., "only rebuild tables that regressed"). v1 is workspace-wide: if the stream regressed, every table in that workspace truncates. A later spec can slice finer.
- **Preserving un-acked local writes through a regression.** The default behavior discards them. Apps that need to preserve offline work go through the interception hook.

## Divergence signals

Three independent signals, any of which triggers reconciliation:

1. **Stream recreated.** JetStream exposes `info.created` — a timestamp set when the stream is first created and preserved across message lifecycle. If the stream name is the same but `created` differs from the last value the client recorded, the stream is a fresh object; everything the client knows is irrelevant.
2. **Last-seq regressed.** `state.last_seq < client_acked_seq` with `info.created` unchanged. The stream was admin-trimmed or restored from an older snapshot. Rare but possible.
3. **First-seq ahead of ack cursor.** `state.first_seq > client_acked_seq + 1`. Messages the client needed for incremental catch-up have aged out (retention-deleted). Not true regression, but the recovery path is the same: we can't replay from where we were.

All three collapse to a single decision: **rebuild from scratch.** v1 doesn't distinguish between them in the recovery path; it distinguishes in the diagnostic payload so devtools / logs can report which condition fired.

## Detection flow

```
            ┌─────────────────────────────┐
            │  Worker boots / resumes for │
            │   workspace wsKey           │
            └──────────────┬──────────────┘
                           ▼
          ┌─────────────────────────────────────┐
          │ JetStream.streamInfo(streamFor(ws)) │
          │   → { created, first_seq, last_seq }│
          └───────────────┬─────────────────────┘
                          ▼
          ┌─────────────────────────────────────┐
          │ Load from OPFS:                     │
          │   savedCreated, savedAckedSeq       │
          └───────────────┬─────────────────────┘
                          ▼
      ┌───────────────────┴───────────────────────┐
      │ Regression?                               │
      │   created != savedCreated                 │
      │   OR last_seq  < savedAckedSeq            │
      │   OR first_seq > savedAckedSeq + 1        │
      └───────────────────┬───────────────────────┘
                          │
           ┌──────────────┴──────────────┐
           │ Yes                         │ No
           ▼                             ▼
   Fire rebase flow          Normal incremental resume
  (see below)                 (consumer from savedAckedSeq + 1)
```

## Default rebase flow

```
1. Emit 'syncing' status on the store (app can render a banner).
2. Notify main thread — subscriptions pause; UI shows last-known state
   but writes are queued.
3. In a single OPFS transaction:
     - TRUNCATE every workspace table in the SQLite replica.
     - Clear per-workspace ack cursor + stream-created metadata.
4. Re-subscribe the JetStream consumer with deliver_policy: all.
5. Stream catches up → events land → DBSP re-materializes views.
6. Persist new stream-created timestamp + new ack cursor.
7. Flush the queued local writes (if any retained by the interception
   hook; default: discarded).
8. Emit 'live' status; the UI returns to normal.
```

Between steps 1 and 8 the store surfaces `connection: 'reconciling'` or similar. Apps that do nothing see a brief flicker as rows disappear and reappear; apps that care can hook the `syncing` status and render a skeleton.

## Public API

### Store signal

```typescript
interface ServerRewoundEvent {
    readonly wsKey: string;
    readonly reason: 'stream-recreated' | 'last-seq-regressed' | 'history-aged-out';
    readonly previous: { created: number; ackedSeq: number };
    readonly current: { created: number; firstSeq: number; lastSeq: number };
}

interface Store {
    // …existing surface…

    /**
     * Fires when a stream regression has been detected and reconciliation
     * is about to begin. Read this in app code to render a syncing UI or
     * log telemetry.
     */
    readonly serverRewound: ServerRewoundEvent | null;

    /**
     * Replace the default reconciliation policy. Called with the
     * regression event; must resolve to one of three outcomes. Defaults
     * to 'truncate' if no handler is installed.
     */
    onServerRewound(
        handler: (ev: ServerRewoundEvent) => Promise<ReconciliationPolicy>,
    ): () => void;
}

type ReconciliationPolicy =
    | { kind: 'truncate' }
    | { kind: 'replay'; preserveLocalWrites: true }
    | { kind: 'defer'; until: 'manual' };
```

### Policy semantics

- **`truncate`** (default) — described above. Drops local, rebuilds from stream. Fast, safe, loses offline writes.
- **`replay`** — truncate, rebuild from stream, **then re-emit un-acked local writes as fresh inserts on the new stream.** This is the "preserve offline work" path. Original event ids / HLCs are rewritten; duplicates are possible if the wipe was intentional. The framework exposes the un-acked rows to the handler so the app can filter before replay.
- **`defer`** — do nothing. The client stays in its pre-regression state, accepting no new events. The app must eventually call `store.rebase({ kind: 'truncate' | 'replay' })` to escape the frozen state. Useful when the app wants the user to confirm before destroying local data.

Most apps will never call `onServerRewound`. The default is correct for most use cases. The hook is there so apps with specific data-loss constraints aren't blocked.

## Edge cases

- **Cold start, no prior cursor.** No regression possible; seed the cursor with the current stream's `(created, 0)` and subscribe from 0.
- **First time seeing a workspace.** Same as cold start — no cursor → no comparison → no regression.
- **Stream exists but is empty.** `first_seq == 0`, `last_seq == 0`. Compare against saved cursor; if saved cursor is `(sameCreated, 0)`, fine — client is caught up on an empty stream. If saved cursor is `(sameCreated, N > 0)`, regression: the stream got wiped without being recreated.
- **Workspace switch, then switch back.** Each workspace has its own OPFS namespace + cursor. No cross-workspace interaction.
- **Two tabs detect regression simultaneously.** Each tab's worker independently truncates its own OPFS replica + resubscribes. No cross-tab coordination needed; both converge.
- **Regression happens while a write is in flight.** The pending write is in the worker's optimistic buffer. At step 3 we save-aside the un-acked buffer. Handler sees it; default `truncate` discards it; `replay` re-emits. Nothing is lost silently.
- **Restate entity state present but table rows gone.** Possible if Restate persisted but JetStream wiped. The entity state is valid (the framework treats Restate as independently authoritative). This is fine — tables and entities have separate sources of truth. The entity state may reference row ids that no longer exist; that's an app-level data-integrity concern, not a framework bug.
- **HLC continuity.** After truncation, the client's HLC resets to match the new stream's highest seen timestamp. No spurious "future-dated" events.

## Implementation sketch

Touches three packages:

### `@syncengine/client` worker

- Extend the existing JetStream subscribe logic to call `streamInfo` before creating the consumer.
- Compare the returned `(created, first_seq, last_seq)` against the persisted cursor.
- If regression detected, emit `SERVER_REWOUND` to main thread; wait for the policy decision; perform the rebuild.
- Persist `(created, last_acked_seq)` to a dedicated OPFS table (`_syncengine_stream_cursor`) keyed by wsKey.

### `@syncengine/client` store (main thread)

- Add `serverRewound` signal and `onServerRewound` subscription.
- Default policy: `truncate`, implemented inline.
- Expose `store.rebase(policy)` for the `defer` escape path.

### `@syncengine/server` (optional telemetry)

- Nothing strictly required; regressions are client-observable. But we should log stream lifecycle events (creation, deletion, admin trim) to a dedicated subject so devtools can display "this stream was wiped at T" alongside the client's regression events.

## Footguns and how we handle them

| Footgun | Handling |
|---|---|
| App silently loses offline writes | Default `truncate` drops them; hook exposes them explicitly for apps that care. Document clearly. |
| Tab A and Tab B diverge in handling a regression | Deterministic: both truncate by default. Apps using `replay` or `defer` must ensure their policy is idempotent across tabs. |
| Regression during reconciliation (double wipe) | Detection re-runs on each resume; a second wipe mid-rebuild just restarts the rebuild from scratch. Idempotent. |
| Very long histories cause slow replay | v1: accept it. v2: snapshot support (consumer starts from a recent snapshot + tail). |
| OPFS quota exceeded mid-truncate | Rare but possible (truncation is itself a transaction). Fall back to drop-and-recreate the database file for this workspace. |
| Intercept hook throws or hangs | Timeout of 30s → fall back to default `truncate` with a console warning. |

## Rollout plan

1. **Cursor persistence** — add `_syncengine_stream_cursor` table to OPFS; wire reads/writes into the worker's subscribe/publish paths. Non-breaking: cursor is advisory until the detector lands.
2. **Detector** — implement the comparison on every subscribe. Emit a `SERVER_REWOUND` event to main thread; initially the main thread just logs it (no policy). This lets us verify detection is correct before wiring behavior.
3. **Default truncate policy** — implement the rebuild flow. Add `serverRewound` store signal. Ship with default enabled; apps with no hook will auto-reconcile.
4. **Interception hook** — add `onServerRewound` + `ReconciliationPolicy` types + `store.rebase()`. Document in the scaffold's comments.
5. **Devtools surface** — show the regression in the timeline/events tab. Helpful during development, especially for `--fresh` workflows.
6. **Scaffold update** — add a one-line example in the scaffold's App.tsx (commented out) showing how to hook `onServerRewound` if the app wants custom policy.

Steps 1–3 land as the MVP. 4–6 can follow.

## Appendix: why not track per-row ack status?

Alternative design: mark each OPFS row as `local_pending | server_confirmed`, so after a regression we'd know which rows are "orphan" (confirmed by the old server but invalid now) vs. "local" (user's offline work, still legitimate).

Rejected for v1 because:

- **Storage overhead.** One extra column on every row of every table in every workspace.
- **Framework complexity.** Every read path has to filter/tag; every write path has to set it.
- **Marginal benefit over the explicit hook.** Apps that want this granularity can maintain a local-only table themselves (e.g., `pendingNotes`) and sync on their own terms. Making it framework-native serves a narrow audience at a broad cost.

The stream-level cursor is cheaper and sufficient for the common case: "the whole workspace drifted, rebuild it."

## Appendix: relationship to the heartbeat primitive

Heartbeats are state-machine-ish Restate workflows. Their `heartbeatStatus` entity is Restate-owned, not JetStream-logged. So heartbeats are naturally insulated from stream regression — if the server is wiped, the heartbeat status entity is either still there (if Restate wasn't wiped) or absent and reinitialized on first read (if it was). Either way, no rebase needed.

The cron/scheduled work pattern composes cleanly: if a heartbeat handler writes into a table via `emit()` from a user entity, and the stream is later regressed, those emitted rows truncate along with everything else. The heartbeat keeps running; its future emissions populate the rebuilt stream. This is the correct behavior — you don't want to resurrect old scheduled-job output.
