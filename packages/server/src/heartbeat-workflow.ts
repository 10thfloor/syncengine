// ── Heartbeat workflow compiler ─────────────────────────────────────────────
//
// Each `.heartbeat.ts` file produces one HeartbeatDef. This module turns
// that def into a Restate workflow with the scheduler loop described in
// the spec. One workflow per definition; Restate replay-determinism
// requires the body to be statically known at registration time.
//
// The scheduler loop:
//   1. arm() — idempotent entry transition to 'running'
//   2. loop:
//      - read status; exit if not 'running'
//      - maxRuns reached → finish() + exit
//      - sleep (unless runAtStart on run 1)
//      - re-read status (catch stop during sleep) — exit if not running
//      - try { user handler } catch { recordError }
//      - recordRun
//
// The double-status-check (pre + post sleep) lets client-side stop()
// exit a workflow mid-interval without needing Restate cancellation.

import * as restate from '@restatedev/restate-sdk';
import { instrument } from '@syncengine/observe';
import type { HeartbeatDef, HeartbeatContext, HeartbeatScope, HeartbeatTrigger } from './heartbeat.js';
import { HEARTBEAT_WORKFLOW_PREFIX, computeSleepMs } from './heartbeat.js';
import { heartbeatStatus } from '@syncengine/core';
import { entityRef } from './entity-ref.js';
import { splitObjectKey, ENTITY_OBJECT_PREFIX } from './entity-keys.js';

/** Payload shape for a heartbeat workflow invocation. */
export interface HeartbeatInvocation {
    readonly scopeKey: string;
    readonly trigger?: HeartbeatTrigger;
    readonly maxRuns?: number;
    readonly runAtStart?: boolean;
}

interface HeartbeatStatusState {
    status: 'idle' | 'running' | 'done';
    runNumber: number;
    stoppedByUser: number;
}

/**
 * Compile a HeartbeatDef into a Restate workflow. Caller passes the
 * result to `endpoint.bind()` alongside regular workflows.
 */
export function buildHeartbeatWorkflow(
    def: HeartbeatDef,
    services?: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>,
): ReturnType<typeof restate.workflow> {
    const resolvedServices = services ?? {};
    return restate.workflow({
        name: `${HEARTBEAT_WORKFLOW_PREFIX}${def.$name}`,
        handlers: {
            run: async (ctx: restate.WorkflowContext, input: HeartbeatInvocation) => {
                const scopeKey = input.scopeKey ?? '';
                const trigger: HeartbeatTrigger = input.trigger ?? def.$trigger;
                const maxRuns = input.maxRuns ?? def.$maxRuns;
                const runAtStart = input.runAtStart ?? def.$runAtStart;

                // Entity key for the status entity is just the heartbeat name —
                // entityRef prepends the workspace prefix from ctx.key.
                const statusEntityKey = def.$name;
                const status = entityRef(ctx, heartbeatStatus, statusEntityKey);

                // arm() is idempotent: concurrent invocations from replica
                // races land in 'running → running' which is a no-op.
                await status.arm(trigger, maxRuns);

                let runNumber = 1;

                // eslint-disable-next-line no-constant-condition
                while (true) {
                    // Pre-sleep status check — bail fast on stop() / reset().
                    const s = await readStatus(ctx, statusEntityKey);
                    if (s.status !== 'running') return;

                    // maxRuns reached.
                    if (maxRuns > 0 && runNumber > maxRuns) {
                        await status.finish();
                        return;
                    }

                    // Delay before tick. Skipped on run 1 when runAtStart.
                    if (!(runAtStart && runNumber === 1)) {
                        const now = await ctx.date.now();
                        const sleepMs = computeSleepMs(def.$every, now);
                        await ctx.sleep(sleepMs);
                    }

                    // Post-sleep re-check — catches a stop() that landed
                    // during the sleep window.
                    const s2 = await readStatus(ctx, statusEntityKey);
                    if (s2.status !== 'running') return;

                    try {
                        const { workspaceId } = splitObjectKey(ctx.key);
                        await instrument.heartbeatTick(
                            { name: def.$name, workspace: workspaceId, runNumber },
                            async () => {
                                const hbCtx = buildHeartbeatContext(ctx, def, scopeKey, runNumber, trigger);
                                (hbCtx as unknown as { services: typeof resolvedServices }).services = resolvedServices;
                                await def.$handler(hbCtx);
                            },
                        );
                        const now = await ctx.date.now();
                        const nextAt = now + computeSleepMs(def.$every, now);
                        await status.recordRun(runNumber, now, nextAt);
                    } catch (err) {
                        await status.recordError(runNumber, formatErr(err));
                    }

                    runNumber += 1;
                }
            },
        },
    });
}

// ── Status reads ────────────────────────────────────────────────────────────

/**
 * Read the current state of the heartbeat status entity. Uses the
 * framework-injected `_read` handler (see entity-runtime.ts) which
 * isn't in the EntityRefProxy's typed surface.
 */
async function readStatus(
    ctx: restate.WorkflowContext,
    statusEntityKey: string,
): Promise<HeartbeatStatusState> {
    const { workspaceId } = splitObjectKey(ctx.key);
    const fullKey = `${workspaceId}/${statusEntityKey}`;
    const client = ctx.objectClient(
        { name: `${ENTITY_OBJECT_PREFIX}${heartbeatStatus.$name}` },
        fullKey,
    ) as { _read: (args: unknown[]) => Promise<{ state: HeartbeatStatusState }> };
    const result = await client._read([]);
    return result.state;
}

// ── Context building ────────────────────────────────────────────────────────

/**
 * Wrap the Restate WorkflowContext with heartbeat metadata. Delegates
 * all Restate primitives (ctx.sleep, ctx.run, ctx.date.now, etc.) to
 * the underlying ctx via property access on the prototype.
 */
function buildHeartbeatContext(
    ctx: restate.WorkflowContext,
    def: HeartbeatDef,
    scopeKey: string,
    runNumber: number,
    trigger: HeartbeatTrigger,
): HeartbeatContext {
    // Restate's WorkflowContext may be implemented as a Proxy with a
    // custom `get` trap; putting it on the prototype chain of a plain
    // object (via Object.create(ctx)) would bypass that trap and leave
    // methods like ctx.sleep / ctx.date undefined. Use an explicit
    // forwarding Proxy with ctx bound as `this` so native context
    // methods work regardless of the SDK's internals.
    const meta = {
        name: def.$name,
        scope: def.$scope satisfies HeartbeatScope,
        scopeKey,
        runNumber,
        trigger,
    } as const;
    return new Proxy(ctx, {
        get(target, prop, _receiver) {
            if (prop in meta) return meta[prop as keyof typeof meta];
            const value = (target as unknown as Record<PropertyKey, unknown>)[prop as PropertyKey];
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
        has(target, prop) {
            return prop in meta || prop in (target as object);
        },
    }) as unknown as HeartbeatContext;
}

// ── Utilities ───────────────────────────────────────────────────────────────

function formatErr(err: unknown): string {
    if (err instanceof Error) return err.message;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}
