# Heartbeat Primitive

**Date:** 2026-04-17
**Status:** Draft
**Scope:** New framework primitive — `@syncengine/server`, `@syncengine/vite-plugin`, `@syncengine/client` (observability + lifecycle control)

## Summary

Add `heartbeat(name, config)` as a first-class framework primitive alongside `table`, `entity`, `topic`, and `defineWorkflow`. A heartbeat is a declaration at authoring time that produces one-or-more durable workflow *instances* at runtime, keyed by `(name, scopeKey)`. Restate owns the scheduling, persistence, leader election, and crash recovery; the framework owns the observability surface and lifecycle controls exposed to clients.

Two trigger modes share one runtime:

- **`trigger: 'boot'`** — auto-starts at workspace (or cluster) boot. The cron flavor. Digests, rollups, cleanup.
- **`trigger: 'manual'`** — waits for a client-side `start()` call. The bounded-workflow flavor. Pulse demos, admin buttons, "run this for 5 minutes".

The pattern the scaffold currently hand-assembles (entity with arm/tick/reset + loop workflow + client kick-off) collapses to one `.heartbeat.ts` file.

## Context: the three-tier store

The platform's runtime has three storage tiers:

- **Tier 1 (NATS JetStream)** — durable ordered event log. Authoritative for Tables. Fan-out delivery, no random-access queries.
- **Tier 2 (Restate)** — entity state + workflow state. Key-serialized, checkpointed, replay-deterministic. Authoritative for actor state.
- **Tier 3 (SQLite/OPFS)** — client-side DBSP-materialized views of a filtered subset of Tier 1. Authoritative for nothing; pure derivation.

A heartbeat is **entirely a Tier 2 construct with Tier 1 spillover**:

- The workflow instance lives in Restate.
- The status entity lives in Restate.
- Status updates broadcast on the existing entity NATS subjects (crossing into Tier 1's delivery fabric, not its durable log).
- Handlers call entities (Tier 2) and transitively cause Tier 1 writes via `emit()`. Handlers **cannot** read Tables — Tier 3 is client-only.

Every failure-mode analysis below collapses to "Restate handles it" except at the Restate↔NATS broadcast boundary, which is already load-bearing for entities and therefore not novel.

## Goals

- Declarative recurring work with Restate-grade durability, leader election, and exactly-once-per-tick semantics.
- Two trigger modes (boot, manual) on one runtime.
- File-based discovery matching `.actor.ts` / `.workflow.ts` / `.topic.ts` conventions.
- Typed handler context with deterministic time and entity composition.
- Client-side lifecycle + observability via `useHeartbeat(def)`.
- Build-time validation with actionable errors.

## Non-Goals (v1)

- Non-Restate execution flavor. One execution model.
- Pause/resume that preserves `runNumber`. `stop() + start()` is a full restart.
- `scope: 'user'` or any per-user granularity — users aren't first-class in the framework yet.
- Cross-workspace fan-out. Use a `scope: 'global'` heartbeat that iterates workspaces inside the handler.
- Direct Table reads from handlers. Fan out via entities that have seen the events.
- Backfill on long outages (current semantic: fire once on recovery, per Restate `ctx.sleep`). `catchUp: true` deferred.

## Mental model

`heartbeat('name', config)` creates a **definition**. The runtime creates one Restate **workflow instance** per `(definition, scopeKey)` where `scopeKey` is:

- `wsKey` for `scope: 'workspace'`
- the literal string `'global'` for `scope: 'global'`

The instance has a **status entity** (also keyed per instance) capturing `{ status, runNumber, lastRunAt, nextRunAt, errorCount, lastError, stoppedByUser }`. Clients subscribe to the status entity to observe; lifecycle RPCs (`start`, `stop`, `reset`) mutate it.

## Lifecycle states

```
                   arm()                      tick()
    ┌─────────┐ ──────────────► ┌─────────────────────────┐
    │         │                 │                         │
    │   idle  │                 │       running           │ ◄───┐
    │         │ ◄───── stop() ──│                         │     │ tick()
    └─────────┘                 └─────────────────────────┘     │ (runNumber++)
      ▲    ▲                               │     │              │
      │    │                               │     └──────────────┘
      │    │                    runNumber >= maxRuns
      │    │ reset()                       │
      │    │                               ▼
      │    │                          ┌─────────┐
      │    └────── stop() ──────────► │  done   │
      │                               └─────────┘
      └── reset() ──────────────────────┘
                                     start() (→ re-arm)
```

Two semantic commitments that aren't obvious from the diagram:

- **`stop()` is persistent across boot** for `trigger: 'boot'` heartbeats. Status carries `stoppedByUser: boolean`. Boot hook reads status, skips invocation when flagged. `reset()` clears the flag. Without this, the UI stop button is a lie — it'd restart on the next deploy.
- **`runNumber` is per-invocation, not lifetime.** `stop() → start()` is a fresh invocation starting at 1. Lifetime totals (if we ever need them) live in a separate field; v1 doesn't.

## API surface

### Minimum useful heartbeat (4 lines of config)

```typescript
// src/heartbeats/digest.heartbeat.ts
import { heartbeat } from '@syncengine/server';

export const digest = heartbeat('digest', {
    every: '30s',
    run: async (ctx) => { /* work */ },
});
```

Defaults: `trigger: 'boot'`, `scope: 'workspace'`, `maxRuns: 0` (unbounded), `runAtStart: false`.

### Full config shape

```typescript
interface HeartbeatConfig {
    trigger?: 'boot' | 'manual';       // default 'boot'
    scope?: 'workspace' | 'global';    // default 'workspace'
    every: number | string;            // ms, duration ('30s'), or cron ('0 */5 * * *')
    maxRuns?: number;                  // default 0 = unbounded
    runAtStart?: boolean;              // default false — wait full interval before first tick
    run: (ctx: HeartbeatContext) => Promise<void>;
}
```

### Interval grammar (v1)

- **Milliseconds** — `every: 5000`.
- **Single-unit durations** — `'500ms'`, `'30s'`, `'5m'`, `'1h'`, `'1d'`. Combined durations (`'1h30m'`) are not supported in v1; use the cron form or the ms equivalent.
- **Standard 5-field cron** — `'0 */5 * * *'`. UTC only (v1). Timezone support deferred.

Invalid intervals are a build-time error at discovery.

### Handler context

```typescript
interface HeartbeatContext extends restate.WorkflowContext {
    readonly name: string;
    readonly scope: 'workspace' | 'global';
    readonly scopeKey: string;       // wsKey or 'global'
    readonly runNumber: number;      // 1-indexed within the current invocation
    readonly trigger: 'boot' | 'manual';
}
```

All Restate `WorkflowContext` features are available: `ctx.sleep`, `ctx.run`, `ctx.date.now()`, `entityRef`.

### Composition rules for handlers

Inside a handler, users **can**:

- Call entity handlers via `entityRef(ctx, entity, key).handler(args)`.
- Run external side effects via `ctx.run(name, fn, { maxRetryAttempts })`.
- Sleep further: `await ctx.sleep(ms)`.
- Read deterministic time: `await ctx.date.now()` (never `Date.now()` — non-deterministic on replay).

Users **cannot**:

- Read Tables — Tier 3 lives only on the client. Fan out via an entity that has seen the events.
- Publish to topics directly — topics are client-originated in v1.
- Schedule one-off future work. Heartbeats are for recurring; use `defineWorkflow` + `ctx.sleep` for one-offs like pomodoro.

### Examples

```typescript
// Boot-triggered, workspace-scoped cron (the common case).
export const digest = heartbeat('digest', {
    every: '30s',
    run: async (ctx) => {
        const now = await ctx.date.now();
        await entityRef(ctx, archive, 'global').rollup(now);
    },
});

// Manual, bounded — the scaffold pulse demo.
export const pulse = heartbeat('pulse', {
    trigger: 'manual',
    every: '5s',
    maxRuns: 12,
    run: async (ctx) => { /* ... */ },
});

// Global-scope cron expression, boot-triggered.
export const nightlyCleanup = heartbeat('nightlyCleanup', {
    scope: 'global',
    every: '0 3 * * *',                // 3am UTC daily
    run: async (ctx) => { /* ... */ },
});

// Fire the first tick immediately on boot (prime state).
export const startupProbe = heartbeat('startupProbe', {
    every: '1m',
    runAtStart: true,
    run: async (ctx) => { /* ... */ },
});
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                               BUILD TIME                                 │
│                                                                          │
│   src/heartbeats/pulse.heartbeat.ts                                      │
│            │                                                             │
│            │  @syncengine/vite-plugin                                    │
│            │    client bundle → stub { $tag, $name, $scope, $trigger,   │
│            │                           $maxRuns, $runAtStart }           │
│            │    server bundle → full definition including run()          │
│            ▼                                                             │
│   loader (@syncengine/server)                                            │
│      validates:                                                          │
│        ├─ unique name across the src/ tree                               │
│        ├─ interval grammar (duration | ms | cron)                        │
│        ├─ scope + trigger compatibility                                  │
│        └─ maxRuns >= 0                                                   │
│      per definition:                                                     │
│        ├─ register Restate workflow  heartbeat_<name>                    │
│        └─ (once, globally)  register heartbeatStatus entity            │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                                 RUNTIME                                  │
│                                                                          │
│   Workspace service boot (wsKey)        Gateway boot (cluster)           │
│         │                                      │                         │
│         │  for each def where                  │  for each def where     │
│         │    scope: 'workspace' &&             │    scope: 'global' &&   │
│         │    trigger: 'boot' &&                │    trigger: 'boot' &&   │
│         │    !status.stoppedByUser:            │    !status.stopped..:   │
│         │      invoke heartbeat_<name>         │      invoke heartbeat.. │
│         │      with scopeKey = wsKey           │      with scopeKey =    │
│         │      idempotencyKey =                │      'global'           │
│         │        boot-<wsBootN>-<wsKey>-<name> │                         │
│         ▼                                      ▼                         │
│                                                                          │
│    Restate                                                               │
│    ├─ heartbeat_<name> workflow (one registration per definition)        │
│    │    key: <scopeKey>              ◄── POST from boot hook             │
│    │    │                            ◄── POST from client start()        │
│    │    │  workflow-per-key dedup                                        │
│    │    │  (Restate consensus picks executor)                            │
│    │    ▼                                                                │
│    │    scheduler loop:                                                  │
│    │      arm() → status = 'running'                                     │
│    │      loop:                                                          │
│    │        read status → 'idle'? exit                                   │
│    │        runNumber > maxRuns? finish() + exit                         │
│    │        sleep(interval)       (ctx.sleep, checkpointed)              │
│    │        read status again     (catch stop() during sleep)            │
│    │        try { await userHandler(hbCtx) }                             │
│    │         catch { status.recordError() }                              │
│    │        status.recordRun(runNumber, now, nextAt)                     │
│    │                                                                     │
│    └─ heartbeatStatus entity                                           │
│         key: "<name>/<scopeKey>"                                         │
│         state changes broadcast ──► ws.{wsId}.entity.heartbeatStatus. │
│                                       <name>/<scopeKey>                  │
│                                              ▼                           │
│                                        Gateway → client worker           │
│                                              ▼                           │
│                                        useHeartbeat(def) re-renders      │
└──────────────────────────────────────────────────────────────────────────┘
```

### One workflow per definition

Restate workflows must be replay-deterministic, which means the body has to be statically known at registration time. A single shared `heartbeat` workflow that dispatched to user handlers by name at invocation time would break determinism on code changes (rename, remove, redeploy).

One workflow registration per `.heartbeat.ts` file = clean replay boundary. Cost: Restate sees N workflow types instead of 1. Acceptable.

### Framework-owned status entity

One entity type, shared across all heartbeats, keyed by `"<name>"` (the workspace scope prefix is added by the entity runtime automatically). Framework-owned — lives in `@syncengine/core` so both the server and client can reference it. The name is `heartbeatStatus` in camelCase rather than the underscore-prefixed form; `defineEntity` rejects leading-underscore names, and the loader reserves the exact string `'heartbeatStatus'` so user entities can't collide.

```typescript
export const heartbeatStatus = defineEntity('heartbeatStatus', {
    state: {
        status: text({ enum: ['idle', 'running', 'done'] }),
        runNumber: integer(),
        lastRunAt: integer(),
        nextRunAt: integer(),
        errorCount: integer(),
        lastError: text(),
        stoppedByUser: integer(),            // 0 | 1, persists across reboots
        trigger: text({ enum: ['boot', 'manual'] }),
        maxRuns: integer(),                  // 0 = unbounded
        // Bumped on every idle/done → running transition. Used as the
        // Restate workflow invocation id so fresh starts after stop()
        // don't collide with workflow-per-key dedup (a completed workflow
        // keeps its key indefinitely in Restate).
        sessionCounter: integer(),
        currentSession: text(),
    },
    transitions: {
        idle:    ['running'],
        running: ['running', 'done', 'idle'],
        done:    ['idle', 'running'],
    },
    handlers: {
        arm(state, trigger, maxRuns) {
            // Idempotent: concurrent arm() calls for an already-running
            // heartbeat serialize per entity key and the 2nd+ no-op by
            // returning state unchanged.
            if (state.status === 'running') return state;
            const nextCounter = (state.sessionCounter ?? 0) + 1;
            return {
                ...state,
                status: 'running' as const,
                trigger, maxRuns,
                runNumber: 0,
                errorCount: 0,
                lastError: '',
                stoppedByUser: 0,
                sessionCounter: nextCounter,
                currentSession: String(nextCounter),
            };
        },
        recordRun(state, runNumber, at, nextAt) {
            if (state.status !== 'running') return state;      // stopped mid-sleep
            return { ...state, runNumber, lastRunAt: at, nextRunAt: nextAt };
        },
        recordError(state, runNumber, msg) {
            return {
                ...state,
                runNumber,
                errorCount: state.errorCount + 1,
                lastError: msg,
            };
        },
        finish(state) {
            return { ...state, status: 'done' as const };
        },
        stop(state) {
            return { ...state, status: 'idle' as const, stoppedByUser: 1 };
        },
        reset() {
            return {
                status: 'idle' as const,
                runNumber: 0, lastRunAt: 0, nextRunAt: 0,
                errorCount: 0, lastError: '',
                stoppedByUser: 0,
                trigger: 'boot' as const, maxRuns: 0,
            };
        },
    },
});
```

The loader registers this once (not per-heartbeat) during framework bootstrap, before any user-defined entities. Users cannot import it from `@syncengine/core` or `@syncengine/server`; the client accesses it only through `useHeartbeat`.

### The workflow body

```typescript
function buildHeartbeatWorkflow(def: HeartbeatDef, handler: HeartbeatHandler) {
    return defineWorkflow(`heartbeat_${def.name}`, async (ctx, input: HeartbeatInvocation) => {
        const statusKey = `${def.name}/${input.scopeKey}`;
        const status = entityRef(ctx, heartbeatStatus, statusKey);

        // Atomic arm: transitions to running, clears counters.
        // Idempotent by Restate entity serialization — second invocation's arm
        // transitions running → running (no-op).
        await status.arm(input.trigger, input.maxRuns ?? 0);

        let runNumber = 1;

        while (true) {
            // Pre-sleep status check — bail quickly on stop() / reset().
            const s = await status.get();
            if (s.status !== 'running') return;

            // maxRuns reached.
            if (input.maxRuns > 0 && runNumber > input.maxRuns) {
                await status.finish();
                return;
            }

            // Delay before tick. Skip on run 1 when runAtStart.
            if (!(input.runAtStart && runNumber === 1)) {
                const now = await ctx.date.now();
                await ctx.sleep(computeSleepMs(def.every, now));
            }

            // Post-sleep re-check — catch stop() that landed during a long sleep.
            const s2 = await status.get();
            if (s2.status !== 'running') return;

            try {
                const hbCtx = buildHeartbeatContext(ctx, def, input, runNumber);
                await handler(hbCtx);
                const now = await ctx.date.now();
                const nextAt = now + nextIntervalMs(def.every, now);
                await status.recordRun(runNumber, now, nextAt);
            } catch (err) {
                await status.recordError(runNumber, formatErr(err));
            }

            runNumber += 1;
        }
    });
}
```

Key design choices:

- **Status checked twice per iteration** (before and after sleep). Pre-sleep exits fast; post-sleep catches stops that landed mid-sleep.
- **`arm()` at entry is idempotent.** Concurrent boot invocations across replicas race, Restate entity serialization picks a winner, the loser's arm is a no-op `running → running`.
- **Handler errors never crash the loop.** They're recorded to the status entity and the loop continues. Only an error escaping our try/catch (framework bug) propagates to Restate, which will retry.

## Invocation idempotency

### Boot registrations

Invocation ID = `boot-<wsBootCount>-<scopeKey>-<defName>`.

`wsBootCount` is a per-workspace monotonic counter persisted by the workspace service. First boot: `boot-1-...`, second: `boot-2-...`, etc. Each workspace boot session gets a fresh idempotency key, so reboot-after-stop-after-reset works.

If the idempotency key matches an in-flight workflow, Restate rejects the duplicate (correct — we don't want two). If it matches a completed one, Restate either rejects or accepts depending on TTL. The boot-counter ensures a fresh key on the next real boot, side-stepping the TTL question.

### Client `start()`

Client generates a random invocation ID per call. Restate's workflow-per-key dedup runs at the workflow level: `heartbeat_pulse` keyed by `ws-abc123` has at most one in-flight invocation. Second concurrent `start()` from another tab gets a "workflow already running" rejection — the client hook swallows this and treats it as success.

### `stop()` and `reset()`

Entity handler calls, serialized by Restate's per-key entity dispatch. No idempotency key needed.

## Client surface

```typescript
export function useHeartbeat<TDef extends HeartbeatDef>(def: TDef): {
    status: 'idle' | 'running' | 'done';
    runNumber: number;
    lastRunAt: number;
    nextRunAt: number;
    lastError: string | null;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    reset: () => Promise<void>;
};
```

Under the hood:

- `status...lastError` stream live via `useEntity(heartbeatStatus, "<name>/<scopeKey>")`.
- `start()` first invokes `heartbeatStatus.arm(trigger, maxRuns)` (serialized per entity key — concurrent tabs collapse to one transition), reads `currentSession` from the returned state, then POSTs to `/__syncengine/rpc/heartbeat/<name>/<currentSession>` with `{ scopeKey, trigger, maxRuns, runAtStart }`. Restate dedups at the workflow-key level. Heartbeats get their own `/rpc/heartbeat/` route (parallel to `/rpc/workflow/`) because they register under a `heartbeat_` prefix rather than the `workflow_` prefix used by user workflows.
- `stop()` invokes `heartbeatStatus.stop` via the store's entity RPC path. Workflow loop exits on the next status check.
- `reset()` invokes `heartbeatStatus.reset`. Clears status back to zeros; does not stop a running workflow — the user must `stop()` first for a clean slate. Document in the hook's jsdoc.

`scopeKey` resolution:

- `scope: 'workspace'` → the client's current `wsKey`.
- `scope: 'global'` → literal `'global'`. Every client sees the same status entity.

Requires `store.invokeEntity(entity, key, handlerName, args)` to exist as a public method. Add if not present; useful outside heartbeats.

## Distributed-system footguns

| Footgun | Handling |
|---|---|
| Multiple replicas firing the same heartbeat | Restate workflow-per-key dedup. Inherited. |
| Split brain across a network partition | Restate Raft-backed consensus picks one executor. Inherited. |
| Server crash mid-sleep | `ctx.sleep` checkpointed; Restate fires once on recovery. Inherited. |
| Server crash mid-handler | Restate replay. Handler side effects outside `ctx.run` may double-fire — user responsibility, documented. |
| `stop()` then reboot → heartbeat restarts | `stoppedByUser` flag on status entity; boot hook respects it. |
| Concurrent `start()` from two tabs | Workflow-key dedup; second rejected, client swallows. |
| Handler throws repeatedly | Errors recorded to status; loop continues; `errorCount` exposed for alerting. |
| Handler hangs indefinitely | v1: user responsibility, document `ctx.run({ timeout })`. v2: framework `handlerTimeoutMs`. |
| Boot hook fails transient-ly | Next boot invokes with a fresh idempotency key (incremented counter); transient failure recovered next time. |
| Definition renamed | Old status entity + workflow orphaned in Restate storage. Non-fatal leak. Documented. |
| Duplicate definition names | Loader throws at discovery with both file paths. |
| Workspace teardown with running manual heartbeat | Workspace service fires `stop()` on all its manual heartbeats during teardown. Global manuals survive until admin cancels. |
| Clock skew client ↔ server | `nextRunAt` is server-computed from `ctx.date.now()`. Countdown UIs use it as a target; minor drift is fine. |
| NATS broadcast lag to clients | Client briefly sees stale status; converges on next broadcast. Benign. |
| Status entity updates reordered in delivery | Restate per-key serialization + HLC on broadcast. Client discards stale frames. |
| Cron DST transition | v1 is UTC only; DST ignored. v2: IANA-TZ support. |

## Build-time validation

The loader runs at workspace-service startup and throws on:

- Duplicate heartbeat names — error message includes both file paths.
- Invalid interval strings — error message enumerates supported forms.
- Invalid cron expressions — error message points at the offending field.
- `maxRuns < 0`.
- `scope: 'global'` + `trigger: 'manual'` with a client-only import in the handler chain (caught by Vite plugin stubbing; loader surfaces as a typecheck failure).

Examples of error messages the loader must produce:

```
Duplicate heartbeat name "digest":
    src/heartbeats/digest.heartbeat.ts
    src/heartbeats/email/digest.heartbeat.ts

Heartbeat names must be unique across the src/ tree because they resolve
to single Restate workflow identities.
```

```
Invalid interval "30sec" in src/heartbeats/pulse.heartbeat.ts.

Supported forms:
  - Milliseconds as a number: 5000
  - Single-unit duration string: "500ms", "30s", "5m", "1h", "1d"
  - Standard 5-field cron (UTC): "0 */5 * * *"

Combined durations like "1h30m" are not supported in v1. Use cron
or the equivalent ms value.
```

## UI integration pattern

```tsx
const { status, runNumber, lastRunAt, nextRunAt, lastError, start, stop, reset } = useHeartbeat(pulse);

{status === 'idle' && (
    <button onClick={start}>start</button>
)}
{status === 'running' && (
    <>
        <Countdown target={nextRunAt} />
        <span>run #{runNumber}</span>
        <button onClick={stop}>stop</button>
    </>
)}
{status === 'done' && (
    <>
        <span>✓ finished after {runNumber} runs</span>
        <button onClick={start}>run again</button>
        <button onClick={reset}>reset</button>
    </>
)}
{lastError && <ErrorBadge message={lastError} />}
```

For `trigger: 'boot'` heartbeats, `start()` is still available for post-stop relaunches; for `trigger: 'manual'` heartbeats, start/stop/reset drive the entire lifecycle.

## Scope

### v1 — in this spec

- Core `heartbeat()` primitive + all config options listed in *API surface*.
- File-based discovery (`*.heartbeat.ts`).
- One-workflow-per-definition Restate backing.
- Framework-owned `heartbeatStatus` entity with documented handler surface.
- `useHeartbeat(def)` hook with observability + lifecycle methods.
- Interval grammar: ms number, single-unit duration, standard 5-field cron (UTC).
- Scaffold port: pulse entity + heartbeat workflow → `pulse.heartbeat.ts`. UI keeps the 4 existing buttons, now backed by the primitive.

### Deferred (v2 candidates)

- `tz` option for cron (IANA timezone).
- Combined durations (`'1h30m'`).
- Pause/resume that preserves `runNumber` (vs. `stop()` → `start()` restart).
- `jitterMs` for fleet-wide stagger.
- `catchUp: true` to fire N missed ticks on recovery (current: fire one).
- `handlerTimeoutMs` framework option.
- Admin RPC surface for listing/canceling heartbeats outside the client store.
- Tooling to clean up orphaned status entities after a rename.
- Global-scope observability surface in devtools (not just the hook).

### Rejected (won't do)

- Non-Restate flavor (`setTimeout` bypass). Two execution models multiply footguns; no proportional value.
- `scope: 'user'`. Users aren't a first-class primitive.
- Cross-workspace fan-out. Use global scope + workspace iteration in the handler.
- Direct Table reads from handlers. Violates the tier boundary (Tables are client-only).

## Rollout plan

Each step is independently ship-able; each step's typechecks pass without the later ones.

1. **Core types + factory** — `@syncengine/server/src/heartbeat.ts`. `HeartbeatDef`, `heartbeat()` factory, interval parser, discovery tag.
2. **`heartbeatStatus` entity** — `@syncengine/core/src/heartbeat-status.ts`. Lives in core (not server) so `@syncengine/client`'s `useHeartbeat` hook can import it without pulling in node-only server deps. Handler bodies are pure state transforms, safe on both sides. Re-exported from `@syncengine/core`'s barrel; `startRestateEndpoint` in `@syncengine/server` registers it automatically alongside user entities.
3. **Loader discovery** — extend `loadDefinitions` to scan `*.heartbeat.ts`, validate, build one workflow per definition.
4. **Vite plugin client stub** — extend `actors.ts` to replace `.heartbeat.ts` server modules with `{ $tag, $name, $scope, $trigger, $maxRuns, $runAtStart }` on the client.
5. **Boot registration hook** — workspace service (per-workspace boot) + gateway (global boot). Reads status `stoppedByUser`, skips if flagged. Uses `boot-<bootCounter>-<scopeKey>-<name>` idempotency keys.
6. **Client hook** — `useHeartbeat(def)` and `store.invokeEntity(entity, key, handler, args)` if not already exposed.
7. **Scaffold port** — delete `src/entities/pulse.actor.ts` + `src/workflows/heartbeat.workflow.ts`, replace with `src/heartbeats/pulse.heartbeat.ts`. UI switches from `useEntity(pulse) + runWorkflow(heartbeat)` to `useHeartbeat(pulse)`; buttons unchanged.
8. **Devtools panel** — separate PR after the above. Lists all heartbeats with status, last-run, error count, action buttons.

Steps 1–7 are the MVP needed to ship the scaffold port. 8 can follow.

## Appendix: why not Restate's native cron

Restate supports scheduled invocations via its admin API. Rejected because:

- Restate cron is configured **out-of-band** (admin API / CLI), not declared alongside the rest of the app. Violates "definitions are files in `src/`".
- Fires a **new invocation per tick** rather than one long-running workflow. Per-run state (`runNumber`, `lastRunAt`) has to live in an external entity anyway.
- No **client-side observability path**. We'd still build `heartbeatStatus` on top.
- We'd lose the uniform stop/start/reset semantics, because Restate cron isn't directly controllable from the client.

What we trade by rolling our own:

- **Timezone handling** — we rebuild it (UTC-only v1).
- **Cron expression parsing** — small internal parser for a 5-field subset.
- **Admin-API pause/resume** — deferred; our story is `stop()`/`reset()` with persistence.

Net: we pick up tighter integration and observability at the cost of a modest validation/parsing surface. Given we already build and maintain our own entity/workflow compilation layer, one more small piece of it is acceptable.

Our self-rescheduling workflow approach relies on one long-running workflow per heartbeat (potentially years of `ctx.sleep`). Restate handles this — it's what `ctx.sleep` is for — and if Restate ever grows a native cron we like better, the API above is compatible because trigger mode is an implementation detail from the user's perspective.
