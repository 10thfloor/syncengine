# Event Bus Phase 2a — Dispatcher Lifecycle + Runtime Smoke

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Task steps use `- [ ]` checkbox syntax.

**Goal:** Wire the `BusDispatcher` built in Phase 1 Task 7 into a real runtime lifecycle, then prove end-to-end message delivery on `apps/test`. After this plan lands, `publish(bus, event)` from an entity handler actually reaches a subscriber workflow.

**Architecture:** A new `BusManager` class in `@syncengine/server` owns every dispatcher across every `(workspace × subscriber)` pair. At server boot it discovers existing workspaces by listing JetStream streams matching `WS_*`, subscribes to `syncengine.workspaces` for new provisions, and spawns one dispatcher per pair on demand. On shutdown it stops every dispatcher in the drain window.

**Spec:** `docs/superpowers/specs/2026-04-20-event-bus-design.md`

**Dependencies:** Phase 1 complete (commits `87bcdbf`..`8d102d0`). `BusDispatcher` from `@syncengine/gateway-core`.

---

## Architectural decisions (locked before task 1)

### Where dispatchers live

Dispatchers are **owned by `@syncengine/server`**, not `@syncengine/gateway-core`. Reason: the dispatcher needs the **workflow list** to know what subscribers exist, and workflow knowledge lives in `@syncengine/server`. Gateway-core stays transport-only.

### When dispatchers spawn

**One dispatcher per `(workspace × subscriber)` pair.** Spawn triggers:

1. **At boot.** Iterate every existing workspace stream (`WS_*`) on NATS JetStream. Spawn dispatchers for every subscriber workflow × every existing workspace.
2. **On workspace provision.** Subscribe to NATS `syncengine.workspaces` (same topic `GatewayCore` already uses for its registry broadcast). When a `WORKSPACE_PROVISIONED` message lands, spawn dispatchers for that workspace × every subscriber workflow.

### When dispatchers stop

1. **On workspace teardown.** Subscribe to the same registry topic for `WORKSPACE_DELETED` messages (future — Phase 1 doesn't publish these yet; the manager handles the add-only case today).
2. **On server shutdown.** BusManager's `shutdown()` stops every dispatcher within the configured drain window.

### Spawn race conditions

Two triggers can race on first provision (boot discovery + registry broadcast). The manager uses a `Set<string>` of active `(workspace, subscriber)` keys and a dedup lock so the same pair never gets two dispatchers. Tests verify the race.

---

## Task A1 — `BusManager` scaffolding

**Files:**
- Create: `packages/server/src/bus-manager.ts`
- Create: `packages/server/src/__tests__/bus-manager.test.ts`

The manager is the single owner of dispatcher lifecycles. Tests use a stub dispatcher factory so we don't need a real NATS.

- [ ] **Step 1: Failing tests for the class shape**

```ts
// packages/server/src/__tests__/bus-manager.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { bus } from '@syncengine/core';
import { defineWorkflow } from '../workflow';
import { on } from '../bus-on';
import { BusManager, type DispatcherFactory } from '../bus-manager';

const orderEvents = bus('orderEvents', {
    schema: z.object({ orderId: z.string(), event: z.string() }),
});

const shipOnPay = defineWorkflow(
    'shipOnPay',
    { on: on(orderEvents) },
    async () => {},
);

function stubFactory(): {
    factory: DispatcherFactory;
    starts: Array<{ workspaceId: string; subscriberName: string }>;
    stops: Array<{ workspaceId: string; subscriberName: string }>;
} {
    const starts: Array<{ workspaceId: string; subscriberName: string }> = [];
    const stops: Array<{ workspaceId: string; subscriberName: string }> = [];
    const factory: DispatcherFactory = (cfg) => ({
        async start() { starts.push({ workspaceId: cfg.workspaceId, subscriberName: cfg.subscriberName }); },
        async stop() { stops.push({ workspaceId: cfg.workspaceId, subscriberName: cfg.subscriberName }); },
    });
    return { factory, starts, stops };
}

describe('BusManager', () => {
    it('spawns one dispatcher per (workspace × subscriber) on explicit registration', async () => {
        const { factory, starts } = stubFactory();
        const mgr = new BusManager({
            natsUrl: 'nats://test',
            restateUrl: 'http://test',
            workflows: [shipOnPay],
            dispatcherFactory: factory,
            // Phase 2a: seed workspaces explicitly for test clarity; discovery lands in A2.
            initialWorkspaceIds: ['ws1', 'ws2'],
        });
        await mgr.start();
        expect(starts).toEqual([
            { workspaceId: 'ws1', subscriberName: 'shipOnPay' },
            { workspaceId: 'ws2', subscriberName: 'shipOnPay' },
        ]);
    });

    it('stop() drains every dispatcher', async () => {
        const { factory, stops } = stubFactory();
        const mgr = new BusManager({
            natsUrl: 'nats://test',
            restateUrl: 'http://test',
            workflows: [shipOnPay],
            dispatcherFactory: factory,
            initialWorkspaceIds: ['ws1', 'ws2'],
        });
        await mgr.start();
        await mgr.stop();
        expect(stops).toHaveLength(2);
    });

    it('onWorkspaceProvisioned spawns dispatchers for a new workspace', async () => {
        const { factory, starts } = stubFactory();
        const mgr = new BusManager({
            natsUrl: 'nats://test',
            restateUrl: 'http://test',
            workflows: [shipOnPay],
            dispatcherFactory: factory,
            initialWorkspaceIds: ['ws1'],
        });
        await mgr.start();
        starts.length = 0;
        await mgr.onWorkspaceProvisioned('ws2');
        expect(starts).toEqual([{ workspaceId: 'ws2', subscriberName: 'shipOnPay' }]);
    });

    it('spawn is idempotent for the same (workspace × subscriber) pair', async () => {
        const { factory, starts } = stubFactory();
        const mgr = new BusManager({
            natsUrl: 'nats://test',
            restateUrl: 'http://test',
            workflows: [shipOnPay],
            dispatcherFactory: factory,
            initialWorkspaceIds: ['ws1'],
        });
        await mgr.start();
        await mgr.onWorkspaceProvisioned('ws1');
        await mgr.onWorkspaceProvisioned('ws1');
        expect(starts).toHaveLength(1);
    });

    it('ignores non-subscriber workflows', async () => {
        const nonSub = defineWorkflow('just-a-workflow', async () => {});
        const { factory, starts } = stubFactory();
        const mgr = new BusManager({
            natsUrl: 'nats://test',
            restateUrl: 'http://test',
            workflows: [nonSub],
            dispatcherFactory: factory,
            initialWorkspaceIds: ['ws1'],
        });
        await mgr.start();
        expect(starts).toEqual([]);
    });
});
```

- [ ] **Step 2: Implement `BusManager` with injectable factory**

```ts
// packages/server/src/bus-manager.ts
import { isBusSubscriberWorkflow, type WorkflowDef } from './workflow';
import type { RetryConfig } from '@syncengine/core';
import { Retry, seconds, minutes } from '@syncengine/core';

/** Pure configuration for a single dispatcher instance. */
export interface DispatcherConfig {
    readonly natsUrl: string;
    readonly restateUrl: string;
    readonly workspaceId: string;
    readonly subscriberName: string;
    readonly busName: string;
    readonly dlqBusName: string;
    readonly filterPredicate?: (event: unknown) => boolean;
    readonly cursor: { kind: 'beginning' | 'latest' | 'sequence' | 'time'; [k: string]: unknown };
    readonly retry: RetryConfig;
}

export interface DispatcherHandle {
    start(): Promise<void>;
    stop(): Promise<void>;
}

export type DispatcherFactory = (cfg: DispatcherConfig) => DispatcherHandle;

export interface BusManagerConfig {
    readonly natsUrl: string;
    readonly restateUrl: string;
    readonly workflows: readonly WorkflowDef[];
    readonly dispatcherFactory: DispatcherFactory;
    readonly initialWorkspaceIds?: readonly string[];
    /** Default retry applied when a subscriber's WorkflowDef doesn't
     *  carry its own config. Phase 2 only — later tasks let workflows
     *  override per-subscriber. */
    readonly defaultRetry?: RetryConfig;
}

const DEFAULT_RETRY: RetryConfig = Retry.exponential({
    attempts: 3,
    initial: seconds(1),
    max: minutes(1),
});

export class BusManager {
    private readonly handles = new Map<string, DispatcherHandle>();
    private readonly config: BusManagerConfig;
    private readonly subscribers: readonly (WorkflowDef & {
        $subscription: NonNullable<WorkflowDef['$subscription']>;
    })[];

    constructor(config: BusManagerConfig) {
        this.config = config;
        this.subscribers = config.workflows.filter(isBusSubscriberWorkflow);
    }

    async start(): Promise<void> {
        for (const workspaceId of this.config.initialWorkspaceIds ?? []) {
            await this.spawnFor(workspaceId);
        }
    }

    async onWorkspaceProvisioned(workspaceId: string): Promise<void> {
        await this.spawnFor(workspaceId);
    }

    async stop(): Promise<void> {
        await Promise.all(
            Array.from(this.handles.values()).map((h) =>
                h.stop().catch(() => { /* best effort */ }),
            ),
        );
        this.handles.clear();
    }

    /** Spawn every missing (workspace × subscriber) dispatcher for the
     *  given workspace. Idempotent — already-active pairs are skipped. */
    private async spawnFor(workspaceId: string): Promise<void> {
        for (const sub of this.subscribers) {
            const key = dispatcherKey(workspaceId, sub.$name);
            if (this.handles.has(key)) continue;
            const busName = sub.$subscription.bus.$name;
            const cfg: DispatcherConfig = {
                natsUrl: this.config.natsUrl,
                restateUrl: this.config.restateUrl,
                workspaceId,
                subscriberName: sub.$name,
                busName,
                dlqBusName: `${busName}.dlq`,
                ...(sub.$subscription.predicate
                    ? { filterPredicate: sub.$subscription.predicate as (e: unknown) => boolean }
                    : {}),
                cursor: sub.$subscription.cursor ?? { kind: 'latest' },
                retry: this.config.defaultRetry ?? DEFAULT_RETRY,
            };
            const handle = this.config.dispatcherFactory(cfg);
            this.handles.set(key, handle);
            await handle.start();
        }
    }
}

function dispatcherKey(workspaceId: string, subscriberName: string): string {
    return `${workspaceId}::${subscriberName}`;
}
```

- [ ] **Verification:** `pnpm --filter @syncengine/server test bus-manager` → 5 tests green. Typecheck clean.

---

## Task A2 — Workspace discovery + registry subscription

**Files:**
- Modify: `packages/server/src/bus-manager.ts` — add `BusManager.attachToNats(nc)` that opens the registry subscription and runs the initial JetStream-streams scan.
- Modify: `packages/server/src/__tests__/bus-manager.test.ts` — additional test for registry-driven spawn.

The manager becomes a live subscriber to `syncengine.workspaces`. On startup it lists JetStream streams matching the `WS_*` pattern and seeds itself. New provisions flow through the registry topic (already published by `workspace.provision` — see `packages/server/src/workspace/workspace.ts` `broadcast-workspace-provisioned`).

- [ ] **Step 1: Failing test — registry-driven spawn**

```ts
it('attachToNats subscribes to syncengine.workspaces and spawns on provision', async () => {
    const { factory, starts } = stubFactory();
    const fakeMsg = { json: () => ({ type: 'WORKSPACE_PROVISIONED', workspaceId: 'ws3' }) };
    async function* fakeIterable() { yield fakeMsg; }

    const fakeNc = {
        subscribe: vi.fn(() => fakeIterable()),
        isClosed: () => false,
        drain: async () => {},
    };

    const mgr = new BusManager({
        natsUrl: 'nats://test',
        restateUrl: 'http://test',
        workflows: [shipOnPay],
        dispatcherFactory: factory,
    });
    await mgr.start();
    await mgr.attachToNats(fakeNc as unknown as import('@nats-io/transport-node').NatsConnection);
    // Give the async loop a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(starts.some(s => s.workspaceId === 'ws3')).toBe(true);
});
```

- [ ] **Step 2: Implement `attachToNats` + stream discovery**

Uses `nc.jetstreamManager().streams.list()` to enumerate existing `WS_<hash>` streams and decode each back to a workspace id. Iterates the registry subscription in the background with graceful shutdown via a cancel flag.

- [ ] **Step 3: Stop path** — `mgr.stop()` unsubscribes from the registry, awaits dispatcher drains, then closes the registry-path NATS connection if the manager owns it.

- [ ] **Verification:** Full `bus-manager.test.ts` green.

---

## Task A3 — Plug `BusDispatcher` into the manager (real factory)

**Files:**
- Modify: `packages/server/src/bus-manager.ts` — add `realDispatcherFactory()` that constructs `BusDispatcher` from `@syncengine/gateway-core`.

Phase 2a keeps the stub factory for unit tests; a production factory lives alongside so prod callers get the real dispatcher without a separate adapter file.

- [ ] **Step 1: Export `realDispatcherFactory`**

```ts
import { BusDispatcher } from '@syncengine/gateway-core';

export const realDispatcherFactory: DispatcherFactory = (cfg) =>
    new BusDispatcher(cfg);
```

- [ ] **Step 2: Compatibility check** — verify `DispatcherConfig` above matches `BusDispatcherConfig` field-by-field. The shapes must be identical so substitution is a no-op at the call site.

- [ ] **Verification:** Typecheck clean. `realDispatcherFactory` is a drop-in for `dispatcherFactory` in production wiring.

---

## Task A4 — Wire `BusManager` into the server boot path

**Files:**
- Modify: `packages/server/src/index.ts` — `startRestateEndpoint()` constructs and attaches a `BusManager`, registers its `stop()` on SIGTERM.
- Modify: `packages/cli/src/build.ts` generated server entry — pass the subscribers list into `startRestateEndpoint`.

- [ ] **Step 1: Extend `startRestateEndpoint` signature**

Add `buses?: BusRef<unknown>[]` to pass subscribers through for orphan warn consistency. `BusManager` wakes up after the Restate endpoint is listening — ensures dispatchers don't POST to Restate before it's ready to accept invocations.

- [ ] **Step 2: Install SIGTERM hook**

`process.on('SIGTERM', async () => { await busManager.stop(); process.exit(0); })`. Idempotent so multiple signals don't double-stop. Skip if the caller already has its own shutdown controller (e.g. the scale-out serve binary).

- [ ] **Step 3: Build.ts generated entry**

After the existing `startRestateEndpoint(...)` call, add wiring that creates + starts a `BusManager`. Keep the current `const buses = ...` collection; pass it in.

- [ ] **Verification:** `pnpm -C apps/test build` succeeds. Running `pnpm dev` shows dispatchers spawning in the log (lightweight `console.log('[bus] dispatching <name> for workspace <id>')` inside the real factory).

---

## Task B1 — Runtime smoke script for apps/test

**Files:**
- Create: `scripts/smoke-bus.sh` — boots the docker-compose stack, drives entity RPCs, asserts NATS + workflow state.

Verifies the full chain: entity handler → `publish()` → NATS → dispatcher → Restate invocation → subscriber workflow → service call → DLQ on forced failure.

- [ ] **Step 1: Happy-path assertions**

```bash
# 1. Boot the stack with apps/test.
APP_DIR=apps/test bash scripts/smoke-docker.sh  # already exists; re-use if possible
# Or a minimal compose for the Phase 2a smoke.

# 2. Drive a place → pay sequence.
curl -sS "http://localhost:3000/__syncengine/rpc/order/O1/place" \
    -H 'x-syncengine-workspace: <wsKey>' \
    -d '{...}'
curl -sS "http://localhost:3000/__syncengine/rpc/order/O1/pay" \
    -H 'x-syncengine-workspace: <wsKey>' \
    -d '{"at": 0}'

# 3. Assert the entity reached `paid`.
curl -sS "http://localhost:3000/__syncengine/rpc/order/O1/_read" ...

# 4. Poll NATS JetStream `/jsz?streams=1` for ws.<wsKey>.bus.orderEvents — expect ≥1 message.
docker compose exec nats wget -qO- http://localhost:8222/jsz?streams=1 | jq '.account_details[].stream_detail[] | select(.name=="WS_<wsKey>")'

# 5. Poll Restate admin for a shipOnPay invocation on O1.
curl -sS "http://localhost:9070/query" -d '{"query": "SELECT * FROM sys_invocation_status WHERE service_name = '\''workflow_shipOnPay'\'' AND service_key LIKE '\''%/O1/%'\''"}'

# 6. Assertion: invocation succeeded within N seconds.
```

- [ ] **Step 2: DLQ assertions**

Force a failure by placing + paying an order with `orderId = 'fail-O2'` (the shipping service stub throws on that prefix). Verify:

- `shipOnPay` for `fail-O2` exhausts retries and terminates.
- `ws.<wsKey>.bus.orderEvents.dlq` receives a message.
- `alertOnShippingFailure` runs (subscriber on the DLQ).

Scripted via the same curl + poll pattern.

- [ ] **Step 3: Error handling + teardown**

Script exits non-zero on any assertion failure. Log the edge + handlers containers on exit so failures are diagnosable. Mirror `scripts/smoke-docker.sh`'s trap + cleanup shape.

- [ ] **Verification:** Runs cleanly against a fresh docker-compose stack on a laptop. Happy path finishes inside ~10 seconds; DLQ path inside ~30 seconds (retries + backoff).

---

## Task B2 — Documentation updates

**Files:**
- Modify: `docs/guides/event-bus.md` — remove "Phase 2 preview" note about dispatcher-lifecycle being unwired; document the BusManager behaviour briefly.
- Modify: `docs/superpowers/plans/2026-04-20-event-bus.md` — mark Phase 2a tasks done when shipped.

- [ ] **Step 1:** Guide gains a "Runtime" section describing the registry-driven dispatcher spawn, orphan-bus warn at boot.
- [ ] **Step 2:** Remove the "BusDispatcher has no per-workspace lifecycle wiring yet" line from the Phase 1 plan's "known gaps" section.

---

## Verification — Phase 2a/2b exit criteria

1. `pnpm -r typecheck` clean.
2. `pnpm -r test` green across all workspace packages.
3. `scripts/smoke-bus.sh` against `apps/test`:
   - Happy path: pay → ship completes inside ~10 s.
   - Failure path: `fail-<id>` routes through DLQ; `alertOnShippingFailure` fires within ~30 s.
4. No dispatcher leaks on SIGTERM — `docker compose down -v` exits cleanly; `docker ps` shows no orphaned consumers.
5. `bus('orderEvents')` with a registered subscriber does NOT print the orphan-bus warning at boot.
6. Phase 1 guide updated to drop the "Phase 2 preview: dispatcher lifecycle" disclaimer.

---

## Out-of-scope (lands in Phase 2c onward)

- `.orderedBy`, `.ordered`, `.concurrency`, `.rate`, `.key` modifiers on `on()`.
- Layer 3 `JetStream.*` escape hatch.
- `BusMode.inMemory()` + `override()` for tests without a running NATS.
- Devtools **Buses** tab.
- Scale-out dispatcher smoke (same BusManager runs in the handlers container; verified separately against `docker-compose.serve.yml`).

Each lives in a follow-up plan once 2a/2b proves the runtime works.
