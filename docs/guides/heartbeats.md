# Heartbeats Guide

> `heartbeat()` declares durable recurring server work. Interval
> or cron, per-workspace or global, with Restate handling
> scheduling, leader election, and crash recovery. Every run
> replays deterministically from the journal.

## When to reach for a heartbeat

| Primitive | Shape | Use for |
|---|---|---|
| `workflow` | One-shot, started by a caller | Sagas, one-per-request orchestration. |
| **`heartbeat`** | **Recurring, scheduled by the framework** | **Digests, GC sweeps, periodic syncs with external APIs, stale-record cleanup.** |

Heartbeats compile to Restate workflows with a scheduling loop. A `(name, scopeKey)` pair is a single singleton — exactly-one-run at a time, even across multiple app processes.

## Five-line declaration

```ts
// src/heartbeats/digest.heartbeat.ts
import { heartbeat } from '@syncengine/server';
import { notifications } from '../services/notifications';

export const digest = heartbeat('digest', {
  every: '1h',
  services: [notifications],
  run: async (ctx) => {
    await ctx.services.notifications.sendDigest();
  },
});
```

Drop under `src/heartbeats/` with a `.heartbeat.ts` suffix. Boot registers the workflow and kicks off the schedule.

## Scheduling options

```ts
every: 5000                              // 5000 ms
every: '500ms' | '30s' | '5m' | '1h' | '1d'
every: '0 */5 * * *'                     // 5-field cron, UTC — every 5 minutes
```

Combined durations (`'1h30m'`) and timezone cron aren't supported — stay with single units or pure UTC cron.

**Scope:**
```ts
scope: 'workspace'   // default — runs once per provisioned workspace
scope: 'global'      // runs once for the whole cluster (system-wide GC, metrics)
```

**Trigger:**
```ts
trigger: 'boot'      // default — starts scheduling on server boot + workspace provision
trigger: 'manual'    // only runs when explicitly started via the framework API
```

**Run bounds:**
```ts
maxRuns: 100         // terminate after 100 invocations (0 = unbounded, default)
runAtStart: true     // fire once immediately at scope start, then on schedule
```

## The ctx contract

Heartbeat handlers get a `HeartbeatContext` that extends the Restate workflow context with scheduling metadata:

| Field | What |
|---|---|
| `ctx.name` | Heartbeat name (`'digest'`). |
| `ctx.scope` | `'workspace'` or `'global'`. |
| `ctx.scopeKey` | Workspace id (scope='workspace') or `'global'`. |
| `ctx.runNumber` | 1-indexed invocation counter. |
| `ctx.trigger` | `'boot'` or `'manual'`. |
| `ctx.services.<name>` | Typed service-port bag. |
| `ctx.run`, `ctx.sleep`, `ctx.date.now()`, `entityRef` | Standard Restate context. |

Handlers must be deterministic — same rules as workflows. Use `ctx.run` for I/O.

## Status visibility

Every heartbeat automatically gets a **status entity** — `_heartbeat_status/<name>/<scopeKey>`. The framework writes into it on every run:

```ts
// Clients can read the status reactively:
const s = useStore<DB>();
const { state } = s.useEntity(heartbeatStatus, `digest/workspace-A`);
// state: { lastRun: number; lastError?: string; runCount: number; ... }
```

That's the hook to surface "last synced 12s ago" in the UI.

Stop / reset / manual-trigger through the status entity's handlers — which double as a programmatic API for operator tools.

## Scope behavior

**`workspace` scope** — the framework starts one invocation per workspace, keyed on the workspace id. New workspaces → automatic schedule attachment. Torn-down workspaces → schedule stops.

**`global` scope** — one invocation for the whole cluster. The framework picks a leader via Restate's single-writer-per-key semantics (scope key = `'global'`).

## Starting / stopping manually

```ts
// From application code (not inside a heartbeat body):
import { entityRef, heartbeatStatus } from '@syncengine/server';

await entityRef(ctx, heartbeatStatus, 'digest/workspace-A').arm();   // schedule start
await entityRef(ctx, heartbeatStatus, 'digest/workspace-A').stop();  // schedule stop
```

`trigger: 'manual'` heartbeats don't auto-start on boot — the app must call `.arm()` explicitly. Useful for heartbeats that should only run when an admin flips a flag.

## Footguns

- **Cron is UTC-only.** No timezone support. If you need "every day at 9am PST", use `'0 17 * * *'` (9am PST = 5pm UTC) and accept that DST drifts twice a year.
- **Combined durations don't work.** `'1h30m'` throws. Express as `'5400s'` or use cron.
- **Step expressions only.** Cron supports `*`, `N`, `N,M,...`, `*/N` — not ranges (`1-5`) or weekday names.
- **Names can't start with `_`.** Reserved for framework entities (`_heartbeat_status`).
- **Non-determinism still breaks replay.** `ctx.sleep(ms)` is durable; `setTimeout` is not. Use `ctx.date.now()`, wrap random IDs in `ctx.run`.
- **Scope changes require redeploy.** Flipping a heartbeat from `'workspace'` to `'global'` creates a different entity — the old one keeps running until you explicitly stop it.

## Pairs with

- **Services** for external-world I/O (send digest email, poll upstream API).
- **Entities** via `entityRef` for durable state mutations (expire records, roll metrics).
- **Bus** to publish domain events from the scheduled work (e.g. `dailyReportReady` event consumed by reactors).

## Testing

No dedicated harness. Unit-test the handler by calling it with a hand-crafted ctx mock:

```ts
import { digest } from '../heartbeats/digest.heartbeat';

const mockCtx = {
  services: { notifications: { sendDigest: vi.fn() } },
  runNumber: 1,
  scope: 'workspace',
  scopeKey: 'ws1',
  run: async (_name, fn) => fn(),
  date: { now: () => 1000 },
  sleep: async () => {},
} as unknown as Parameters<typeof digest.$handler>[0];

await digest.$handler(mockCtx);
expect(mockCtx.services.notifications.sendDigest).toHaveBeenCalled();
```

Integration tests run the full framework boot — same pattern as workflow integration tests.

## Links

- Spec: `docs/superpowers/specs/2026-04-17-heartbeat-primitive.md`
- Server code: `packages/server/src/heartbeat.ts`, `heartbeat-workflow.ts`
- Status entity: `packages/core/src/heartbeat-status.ts`
