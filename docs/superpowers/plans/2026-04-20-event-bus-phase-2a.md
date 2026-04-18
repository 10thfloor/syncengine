# Event Bus Phase 2a — Dispatcher Lifecycle + Runtime Smoke

> **STATUS: ✅ shipped.** Commits `0fbd92e` (A1) through `dfc5129` (B2). A6 + A7 follow-on landed as `a8dd75e` / `eb0beb1`.
> End-to-end smoke proved via `bash scripts/smoke-docker.sh --buses` — happy path, DLQ path, consumer reuse across
> app-container restart. See `2026-04-21-event-bus-epic-completion.md` for the consolidated closeout summary.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Task steps use `- [ ]` checkbox syntax.

**Goal:** Wire the `BusDispatcher` built in Phase 1 Task 7 into a real runtime lifecycle, then prove end-to-end message delivery on `apps/test`. After this plan lands, `publish(bus, event)` from an entity handler actually reaches a subscriber workflow.

**Architecture:** A new `BusManager` class in `@syncengine/server` owns every dispatcher across every `(workspace × subscriber)` pair. At server boot it discovers existing workspaces by listing JetStream streams matching `WS_*`, subscribes to `syncengine.workspaces` for new provisions, and spawns one dispatcher per pair on demand. On shutdown it stops every dispatcher in the drain window.

**Spec:** `docs/superpowers/specs/2026-04-20-event-bus-design.md`

**Dependencies:** Phase 1 complete (commits `87bcdbf`..`8d102d0`). `BusDispatcher` + `BusDispatcherConfig` from `@syncengine/gateway-core`.

---

## Architectural decisions (locked before task 1)

### Where dispatchers live

Dispatchers are **owned by `@syncengine/server`**, not `@syncengine/gateway-core`. Reason: the dispatcher needs the **workflow list** to know what subscribers exist, and workflow knowledge lives in `@syncengine/server`. Gateway-core stays transport-only.

### Type source of truth

`BusManager` **imports `BusDispatcherConfig` from `@syncengine/gateway-core`** — no redeclared mirror type. Any change in gateway-core's config shape surfaces as a compile error in the manager instead of a runtime drift.

### Spawn parallelism + failure isolation

`BusManager.spawnFor(workspaceId)` starts every dispatcher for that workspace **in parallel via `Promise.allSettled`**. A failed `start()` (flaky NATS, bad retry config) is logged and the offending handle is dropped — the remaining subscribers come up normally. One broken workflow never browns out the others.

### When dispatchers spawn

**One dispatcher per `(workspace × subscriber)` pair.** Triggers:

1. **At boot.** Iterate every existing workspace stream (`WS_*`) on NATS JetStream. Spawn dispatchers for every subscriber workflow × every existing workspace.
2. **On workspace provision.** Subscribe to NATS `syncengine.workspaces` (same topic `GatewayCore` already uses for its registry broadcast). When a `WORKSPACE_PROVISIONED` message lands, spawn dispatchers for that workspace × every subscriber workflow.

### When dispatchers stop

1. **On workspace teardown.** Subscribe to the same registry topic for `WORKSPACE_DELETED` messages (future — Phase 1 doesn't publish these yet; the manager handles the add-only case today).
2. **On server shutdown.** `BusManager.stop()` stops every dispatcher within the configured drain window.

### Spawn race conditions

Two triggers can race on first provision (boot discovery + registry broadcast). The manager uses a `Set<string>` of active `(workspace, subscriber)` keys keyed on `<wsId>::<subName>` with a dedup lock so the same pair never gets two dispatchers. Tests verify the race.

### Signal handler opt-out

`BusManager` takes `installSignalHandlers: boolean` on the constructor. `syncengine start` (where the manager is the process's only shutdown owner) passes `true`. The scale-out serve binary — which already has `createShutdownController` owning SIGTERM — passes `false` and calls `manager.stop()` from the shared drain path. Prevents duplicate handlers fighting over the signal.

### Per-subscriber retry config

Lives on the `WorkflowDef` itself (a new `$retry` field populated by a `retry:` option on `defineWorkflow`). Subscribers without one fall back to the manager's `defaultRetry`. This lets a slow-integration workflow ask for longer backoff without every other subscriber inheriting that delay.

---

## Task A1 — `BusManager` scaffolding

**Files:**
- Create: `packages/server/src/bus-manager.ts`
- Create: `packages/server/src/__tests__/bus-manager.test.ts`

The manager is the single owner of dispatcher lifecycles. Tests use a stub dispatcher factory so we don't need a real NATS.

- [ ] **Step 1: Failing tests — including multi-subscriber fan-out + start-failure resilience**

```ts
// packages/server/src/__tests__/bus-manager.test.ts
import { describe, it, expect, vi } from 'vitest';
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
const auditOnEvent = defineWorkflow(
    'auditOnEvent',
    { on: on(orderEvents) },
    async () => {},
);

type StubCall = { workspaceId: string; subscriberName: string };
function stubFactory(options: { startThrowsFor?: string } = {}): {
    factory: DispatcherFactory;
    starts: StubCall[];
    stops: StubCall[];
} {
    const starts: StubCall[] = [];
    const stops: StubCall[] = [];
    const factory: DispatcherFactory = (cfg) => ({
        async start() {
            if (options.startThrowsFor && cfg.subscriberName === options.startThrowsFor) {
                throw new Error(`boom: ${cfg.subscriberName}`);
            }
            starts.push({ workspaceId: cfg.workspaceId, subscriberName: cfg.subscriberName });
        },
        async stop() { stops.push({ workspaceId: cfg.workspaceId, subscriberName: cfg.subscriberName }); },
    });
    return { factory, starts, stops };
}

function mgr(workflows: readonly unknown[], initial: string[] = [], override: Partial<ConstructorParameters<typeof BusManager>[0]> = {}) {
    const { factory, starts, stops } = stubFactory();
    return {
        starts, stops,
        instance: new BusManager({
            natsUrl: 'nats://test',
            restateUrl: 'http://test',
            workflows: workflows as Parameters<typeof BusManager>[0]['workflows'],
            dispatcherFactory: factory,
            initialWorkspaceIds: initial,
            installSignalHandlers: false,
            ...override,
        }),
    };
}

describe('BusManager', () => {
    it('spawns one dispatcher per (workspace × subscriber) on startup', async () => {
        const { instance, starts } = mgr([shipOnPay], ['ws1', 'ws2']);
        await instance.start();
        const pairs = starts.map(s => `${s.workspaceId}/${s.subscriberName}`).sort();
        expect(pairs).toEqual(['ws1/shipOnPay', 'ws2/shipOnPay']);
    });

    it('fan-out: multiple subscribers on the same bus each get a dispatcher per workspace', async () => {
        const { instance, starts } = mgr([shipOnPay, auditOnEvent], ['ws1']);
        await instance.start();
        const subs = starts.map(s => s.subscriberName).sort();
        expect(subs).toEqual(['auditOnEvent', 'shipOnPay']);
    });

    it('one dispatcher start() failing does not block the others', async () => {
        const { factory } = stubFactory({ startThrowsFor: 'shipOnPay' });
        const starts: StubCall[] = [];
        const spyFactory: DispatcherFactory = (cfg) => {
            const h = factory(cfg);
            return {
                start: async () => { try { await h.start(); starts.push({ workspaceId: cfg.workspaceId, subscriberName: cfg.subscriberName }); } catch (e) { throw e; } },
                stop: h.stop,
            };
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const instance = new BusManager({
            natsUrl: 'nats://test',
            restateUrl: 'http://test',
            workflows: [shipOnPay, auditOnEvent],
            dispatcherFactory: spyFactory,
            initialWorkspaceIds: ['ws1'],
            installSignalHandlers: false,
        });
        await instance.start();
        expect(starts.map(s => s.subscriberName)).toEqual(['auditOnEvent']);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/shipOnPay/));
        warn.mockRestore();
    });

    it('stop() drains every dispatcher', async () => {
        const { instance, stops } = mgr([shipOnPay, auditOnEvent], ['ws1', 'ws2']);
        await instance.start();
        await instance.stop();
        expect(stops).toHaveLength(4);  // 2 workspaces × 2 subscribers
    });

    it('onWorkspaceProvisioned spawns dispatchers for a new workspace', async () => {
        const { instance, starts } = mgr([shipOnPay], ['ws1']);
        await instance.start();
        starts.length = 0;
        await instance.onWorkspaceProvisioned('ws2');
        expect(starts).toEqual([{ workspaceId: 'ws2', subscriberName: 'shipOnPay' }]);
    });

    it('spawn is idempotent for the same (workspace × subscriber) pair', async () => {
        const { instance, starts } = mgr([shipOnPay], ['ws1']);
        await instance.start();
        await instance.onWorkspaceProvisioned('ws1');
        await instance.onWorkspaceProvisioned('ws1');
        expect(starts).toHaveLength(1);
    });

    it('ignores non-subscriber workflows', async () => {
        const nonSub = defineWorkflow('plain', async () => {});
        const { instance, starts } = mgr([nonSub], ['ws1']);
        await instance.start();
        expect(starts).toEqual([]);
    });
});
```

- [ ] **Step 2: Implement `BusManager` — parallel `Promise.allSettled`, no redeclared config type**

```ts
// packages/server/src/bus-manager.ts
import { isBusSubscriberWorkflow, type WorkflowDef } from './workflow';
import {
    Retry, seconds, minutes,
    type RetryConfig,
} from '@syncengine/core';
import type { BusDispatcherConfig } from '@syncengine/gateway-core';

/** Dispatcher handle produced by the factory. Matches the contract
 *  @syncengine/gateway-core's `BusDispatcher` already implements. */
export interface DispatcherHandle {
    start(): Promise<void>;
    stop(): Promise<void>;
}

/** Factory plugs a concrete dispatcher (real gateway-core BusDispatcher
 *  in prod, a stub in unit tests). Config shape is imported from
 *  gateway-core — single source of truth, no drift. */
export type DispatcherFactory = (cfg: BusDispatcherConfig) => DispatcherHandle;

export interface BusManagerConfig {
    readonly natsUrl: string;
    readonly restateUrl: string;
    readonly workflows: readonly WorkflowDef[];
    readonly dispatcherFactory: DispatcherFactory;
    readonly initialWorkspaceIds?: readonly string[];
    /** Fallback retry when a subscriber didn't declare one on its
     *  WorkflowDef. See Task A4 for the per-subscriber override path. */
    readonly defaultRetry?: RetryConfig;
    /** Install process-level SIGTERM/SIGINT hooks that drain via stop().
     *  `true` for single-process `syncengine start`; `false` when the
     *  caller owns shutdown already (scale-out serve binary uses the
     *  shared shutdown controller). */
    readonly installSignalHandlers?: boolean;
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
        if (config.installSignalHandlers ?? true) this.installSignalHandlers();
    }

    async start(): Promise<void> {
        const seed = this.config.initialWorkspaceIds ?? [];
        await Promise.all(seed.map((wsId) => this.spawnFor(wsId)));
    }

    async onWorkspaceProvisioned(workspaceId: string): Promise<void> {
        await this.spawnFor(workspaceId);
    }

    async stop(): Promise<void> {
        const pending = Array.from(this.handles.values()).map((h) =>
            h.stop().catch(() => { /* best effort drain */ }),
        );
        this.handles.clear();
        await Promise.all(pending);
    }

    /** Spawn every missing (workspace × subscriber) dispatcher for the
     *  given workspace. Spawns run in parallel; one failure does not
     *  block others. Already-active pairs are skipped (idempotent). */
    private async spawnFor(workspaceId: string): Promise<void> {
        const pending: Promise<void>[] = [];
        for (const sub of this.subscribers) {
            const key = dispatcherKey(workspaceId, sub.$name);
            if (this.handles.has(key)) continue;
            pending.push(this.spawnOne(workspaceId, sub, key));
        }
        await Promise.allSettled(pending);
    }

    private async spawnOne(
        workspaceId: string,
        sub: (typeof this.subscribers)[number],
        key: string,
    ): Promise<void> {
        const busName = sub.$subscription.bus.$name;
        const cfg: BusDispatcherConfig = {
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
            retry: sub.$retry ?? this.config.defaultRetry ?? DEFAULT_RETRY,
        };
        const handle = this.config.dispatcherFactory(cfg);
        this.handles.set(key, handle);
        try {
            await handle.start();
        } catch (err) {
            this.handles.delete(key);
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
                `[bus-manager] dispatcher for ${sub.$name} on ${workspaceId} failed to start: ${msg}. ` +
                `Other subscribers remain active. Retry on next spawnFor() call.`,
            );
        }
    }

    private installSignalHandlers(): void {
        let stopped = false;
        const handler = async (signal: NodeJS.Signals) => {
            if (stopped) return;
            stopped = true;
            console.log(`[bus-manager] ${signal} received; draining dispatchers`);
            await this.stop();
        };
        process.once('SIGTERM', handler);
        process.once('SIGINT', handler);
    }
}

function dispatcherKey(workspaceId: string, subscriberName: string): string {
    return `${workspaceId}::${subscriberName}`;
}
```

- [ ] **Verification:** `pnpm --filter @syncengine/server test bus-manager` → 7 tests green. Typecheck clean.

---

## Task A2 — Workspace discovery + registry subscription

**Files:**
- Modify: `packages/server/src/bus-manager.ts` — add `BusManager.attachToNats(nc)` that opens the registry subscription and runs the initial JetStream-streams scan.
- Modify: `packages/server/src/__tests__/bus-manager.test.ts` — additional tests for registry spawn + cancel-on-stop.

The manager becomes a live subscriber to `syncengine.workspaces`. On startup it lists JetStream streams matching the `WS_*` pattern and seeds itself. New provisions flow through the registry topic (already published by `workspace.provision` — see `packages/server/src/workspace/workspace.ts` `broadcast-workspace-provisioned`).

- [ ] **Step 1: Failing tests — registry spawn + stop cancels the subscription loop**

```ts
it('attachToNats subscribes to syncengine.workspaces and spawns on provision', async () => {
    const { instance, starts } = mgr([shipOnPay]);
    await instance.start();

    let resolveMsg!: (msg: { json: () => unknown }) => void;
    const fakeIterable = (async function* () {
        while (true) {
            const msg = await new Promise<{ json: () => unknown }>((r) => { resolveMsg = r; });
            yield msg;
        }
    })();
    const fakeSub = fakeIterable as AsyncIterableIterator<{ json: () => unknown }> & { unsubscribe: () => void };
    fakeSub.unsubscribe = () => { /* handled in cancel test */ };

    const fakeNc = {
        subscribe: vi.fn(() => fakeSub),
        jetstreamManager: vi.fn(async () => ({ streams: { list: () => emptyStreamLister() } })),
        isClosed: () => false,
        drain: async () => {},
    };
    await instance.attachToNats(fakeNc as never);

    resolveMsg({ json: () => ({ type: 'WORKSPACE_PROVISIONED', workspaceId: 'ws3' }) });
    // Give the async loop a tick.
    await new Promise((r) => setImmediate(r));

    expect(starts.some((s) => s.workspaceId === 'ws3')).toBe(true);
});

it('stop() cancels the registry subscription loop', async () => {
    const { instance } = mgr([shipOnPay]);
    await instance.start();

    let iteratorClosed = false;
    const fakeSub = {
        [Symbol.asyncIterator]() { return this; },
        async next() { return { value: undefined, done: iteratorClosed }; },
        unsubscribe() { iteratorClosed = true; },
    };
    const fakeNc = {
        subscribe: () => fakeSub,
        jetstreamManager: async () => ({ streams: { list: () => emptyStreamLister() } }),
        isClosed: () => false,
        drain: async () => {},
    };
    await instance.attachToNats(fakeNc as never);
    await instance.stop();
    expect(iteratorClosed).toBe(true);
});

function emptyStreamLister() {
    return (async function* () { /* no streams */ })();
}
```

- [ ] **Step 2: Implement `attachToNats` + stream discovery**

Uses `jetstreamManager().streams.list()` to enumerate existing `WS_*` streams, decodes each back to a workspace id, and seeds the manager. Iterates the registry subscription in the background with a cancel flag checked inside the for-await loop.

```ts
async attachToNats(nc: NatsConnection): Promise<void> {
    // 1. Initial discovery from existing streams.
    const jsm = await nc.jetstreamManager();
    const discovered: string[] = [];
    for await (const info of jsm.streams.list()) {
        if (info.config.name.startsWith('WS_')) {
            discovered.push(info.config.name.slice(3));  // strip 'WS_' prefix
        }
    }
    await Promise.all(discovered.map((wsId) => this.spawnFor(wsId)));

    // 2. Live subscription for future provisions.
    const sub = nc.subscribe('syncengine.workspaces');
    this.registrySubscription = sub;
    (async () => {
        for await (const msg of sub) {
            if (this.stopped) break;
            try {
                const data = msg.json<{ type: string; workspaceId?: string }>();
                if (data.type === 'WORKSPACE_PROVISIONED' && typeof data.workspaceId === 'string') {
                    await this.onWorkspaceProvisioned(data.workspaceId);
                }
            } catch { /* decode error */ }
        }
    })().catch(() => { /* sub closed */ });
}
```

- [ ] **Step 3: Wire cancel into `stop()`**

```ts
async stop(): Promise<void> {
    this.stopped = true;
    if (this.registrySubscription) {
        try { this.registrySubscription.unsubscribe(); } catch { /* best effort */ }
    }
    // ... existing drain logic ...
}
```

- [ ] **Verification:** Full `bus-manager.test.ts` green. Subscription loop exits cleanly on `stop()`.

---

## Task A3 — Plug `BusDispatcher` into the manager (real factory)

**Files:**
- Modify: `packages/server/src/bus-manager.ts` — add `realDispatcherFactory()` that constructs `BusDispatcher` from `@syncengine/gateway-core`.

No shape mapping needed since A1 imports `BusDispatcherConfig` directly.

- [ ] **Step 1: Export `realDispatcherFactory`**

```ts
import { BusDispatcher } from '@syncengine/gateway-core';

export const realDispatcherFactory: DispatcherFactory = (cfg) =>
    new BusDispatcher(cfg);
```

- [ ] **Verification:** Typecheck clean. `realDispatcherFactory` is a drop-in for `dispatcherFactory` in production wiring.

---

## Task A4 — Per-subscriber retry on `WorkflowDef`

**Files:**
- Modify: `packages/server/src/workflow.ts` — `WorkflowOptions<TInput>` accepts `retry: RetryConfig`; `WorkflowDef` exposes `$retry?`.
- Modify: `packages/server/src/__tests__/workflow-subscriber.test.ts` — test that `retry` flows through.
- Modify: `packages/server/src/bus-manager.ts` — A1's `spawnOne` already reads `sub.$retry ?? this.config.defaultRetry ?? DEFAULT_RETRY`, so the fallback chain is ready; just make sure the test covers it.

- [ ] **Step 1: Test the flow**

```ts
it('per-subscriber retry overrides the manager default', async () => {
    const custom = Retry.exponential({ attempts: 9, initial: seconds(5), max: minutes(10) });
    const slowSub = defineWorkflow(
        'slow',
        { on: on(orderEvents), retry: custom },
        async () => {},
    );
    const { instance } = mgr([slowSub], ['ws1']);
    // Spy on the factory to capture the config it receives.
    // Assert the dispatcher got `retry: custom` instead of the default.
});
```

- [ ] **Step 2: Extend `WorkflowOptions` + `WorkflowDef`**

```ts
export interface WorkflowOptions<TInput = unknown> {
    readonly services?: readonly AnyService[];
    readonly on?: Subscription<TInput>;
    readonly retry?: RetryConfig;
}

export interface WorkflowDef<TName extends string = string, TInput = unknown> {
    readonly $tag: 'workflow';
    readonly $name: TName;
    readonly $handler: (ctx: restate.WorkflowContext, input: TInput) => Promise<void>;
    readonly $services: readonly AnyService[];
    readonly $subscription?: Subscription<TInput>;
    readonly $retry?: RetryConfig;
}
```

Threading `retry` from options → `$retry` in `defineWorkflow`'s implementation mirrors the existing `services` / `subscription` pattern.

- [ ] **Verification:** `pnpm --filter @syncengine/server test workflow-subscriber bus-manager` green. `defineWorkflow` without `retry:` compiles (unchanged). `defineWorkflow` with `retry:` flows to the manager.

---

## Task A5 — Wire `BusManager` into the server boot path

**Files:**
- Modify: `packages/server/src/index.ts` — `startRestateEndpoint()` constructs a `BusManager`, attaches it to NATS after the Restate endpoint is listening.
- Modify: `packages/cli/src/build.ts` generated server entry — pass `buses` and subscribers through.

The manager wakes up *after* the Restate endpoint is listening so dispatchers don't POST to Restate before it's ready.

- [ ] **Step 1: Extend `startRestateEndpoint`**

Add a parameter (or options bag — see `installSignalHandlers` decision): `{ busManager?: BusManager }`. If present, call `await busManager.attachToNats(nc)` after the endpoint listens. If a caller hasn't constructed one, skip (back-compat for dev fixtures).

- [ ] **Step 2: Generated server entry (cli/build.ts)**

After the `const buses = ...` collection that already exists from Phase 1 Task 12, construct a `BusManager`:

```ts
const busManager = new BusManager({
    natsUrl: process.env.SYNCENGINE_NATS_URL ?? 'ws://localhost:9222',
    restateUrl: process.env.SYNCENGINE_RESTATE_URL ?? 'http://localhost:8080',
    workflows,
    dispatcherFactory: realDispatcherFactory,
    installSignalHandlers: true,
});
await busManager.start();
// later, after NATS connects, call busManager.attachToNats(nc)
```

Exact wiring depends on where NATS gets constructed in the generated entry — today `startHttpServer` owns one, and the workspace-bridge owns another. The manager should use its own connection so shutdown semantics are independent.

- [ ] **Step 3: Scale-out path (docker-compose.serve.yml)**

The handlers container needs the same BusManager. Since handlers runs `SYNCENGINE_HANDLERS_ONLY=1` and skips `startHttpServer`, the BusManager must spin up inside the handlers-only branch of the generated entry too. Add a parallel `if (process.env.SYNCENGINE_HANDLERS_ONLY === '1') { ... }` branch that constructs + starts the manager with `installSignalHandlers: false` (letting the existing shutdown drain take over).

- [ ] **Verification:** `pnpm -C apps/test build` succeeds. Running `pnpm dev` shows dispatcher-spawn log lines on workspace provision.

---

## Task B1 — Extend `scripts/smoke-docker.sh` with bus assertions

**Files:**
- Modify: `scripts/smoke-docker.sh` — add a `--buses` flag that runs the bus-flow assertions after the HTML injection assertions.

One script, two modes. Avoids a separate `smoke-bus.sh` that would diverge.

- [ ] **Step 1: Happy-path bus assertions behind `--buses`**

```bash
if [[ "${1:-}" == "--buses" ]]; then
    log "extracting wsKey from /?workspace=alice response"
    wsKey=$(extract_ws_key_from_html)

    log "placing + paying an order"
    curl -sS "http://localhost:3000/__syncengine/rpc/order/O1/place" \
        -H "x-syncengine-workspace: $wsKey" -d '{}' >/dev/null
    curl -sS "http://localhost:3000/__syncengine/rpc/order/O1/pay" \
        -H "x-syncengine-workspace: $wsKey" -d '{"at": 0}' >/dev/null

    log "polling for orderEvents message on JetStream"
    for i in {1..20}; do
        count=$(docker compose exec nats wget -qO- "http://localhost:8222/jsz?streams=1" \
            | jq ".account_details[].stream_detail[] | select(.name == \"WS_$wsKey\") | .state.messages")
        [[ "$count" -ge 1 ]] && break
        sleep 1
    done
    [[ "$count" -ge 1 ]] || fail "no messages on orderEvents after 20s"

    log "polling Restate admin for shipOnPay invocation"
    # ... curl /query, assert row exists with status=succeeded
fi
```

- [ ] **Step 2: DLQ-path assertions**

Force a failure by placing + paying `orderId=fail-O2` (the shipping stub throws on that prefix). Verify:

- `shipOnPay` for `fail-O2` exhausts retries and terminates.
- `ws.$wsKey.bus.orderEvents.dlq` receives a message.
- `alertOnShippingFailure` runs (subscriber on the DLQ).

- [ ] **Step 3: Teardown assertion — no orphan consumers**

Before `docker compose down -v`, snapshot the consumer count per subscriber stream. After the intentional tear-down at the end of the script, Docker Desktop evicts them naturally. The *in-run* assertion is: the dispatcher shut down cleanly — no "consumer already exists" errors on a second smoke run (since the dispatcher uses a stable durable name, restart resumes the same consumer rather than creating duplicates).

```bash
log "verifying stable durable-consumer reuse across smokes"
stable_name="bus:orderEvents:shipOnPay"
consumer_count=$(docker compose exec nats wget -qO- "http://localhost:8222/connz?stream=WS_$wsKey" \
    | jq "[.consumers[] | select(.name == \"$stable_name\")] | length")
[[ "$consumer_count" -eq 1 ]] || fail "expected exactly 1 consumer named $stable_name; found $consumer_count"
```

- [ ] **Verification:** `bash scripts/smoke-docker.sh --buses` runs happy + DLQ path inside ~45 s. Re-run produces the same result (no duplicate consumer).

---

## Task B2 — Documentation updates

**Files:**
- Modify: `docs/guides/event-bus.md` — add a "Runtime" section describing BusManager spawn triggers; note durable-consumer restart semantics.
- Modify: `docs/superpowers/plans/2026-04-20-event-bus.md` — mark the "BusDispatcher has no per-workspace lifecycle wiring yet" known-gap as resolved.

- [ ] **Step 1:** Guide gains a "How the runtime spawns dispatchers" section covering boot discovery + registry topic + durable-consumer resume-on-restart.
- [ ] **Step 2:** Phase 1 plan's "Known gaps going into Phase 2" section removes the dispatcher-lifecycle line.

---

## Verification — Phase 2a/2b exit criteria

1. `pnpm -r typecheck` clean.
2. `pnpm -r test` green across all workspace packages.
3. `bash scripts/smoke-docker.sh --buses` against `apps/test`:
   - Happy path: pay → ship completes inside ~10 s.
   - Failure path: `fail-<id>` routes through DLQ; `alertOnShippingFailure` fires within ~30 s.
   - Consumer-reuse check passes on re-run.
4. No dispatcher leaks on SIGTERM — `docker compose down -v` exits cleanly; re-running the smoke confirms stable durable names (no duplicates).
5. `bus('orderEvents')` with a registered subscriber does NOT print the orphan-bus warning at boot.
6. `defineWorkflow({ retry: Retry.exponential(...) })` overrides the manager default; test proves the custom config reaches the dispatcher factory.
7. Single-process (`syncengine start`): SIGTERM drains the BusManager before exit.
8. Scale-out (`docker-compose.serve.yml`): handlers container runs the BusManager; edge container does NOT (handlers-only mode is the subscriber tier).
9. Phase 1 guide updated to drop the "Phase 2 preview: dispatcher lifecycle" disclaimer.

---

## Out-of-scope (lands in Phase 2c onward)

- `.orderedBy`, `.ordered`, `.concurrency`, `.rate`, `.key` modifiers on `on()`.
- Layer 3 `JetStream.*` escape hatch.
- `BusMode.inMemory()` + `override()` for tests without a running NATS.
- Devtools **Buses** tab.
- `WORKSPACE_DELETED` registry broadcast handling (add when the workspace lifecycle adds teardown messages).

Each lives in a follow-up plan once 2a/2b proves the runtime works.
