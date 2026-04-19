// ── Framework-owned status entity for heartbeats ────────────────────────────
//
// One entity type, keyed by "<heartbeat name>/<scopeKey>", tracks the
// lifecycle state of each heartbeat invocation. The scheduler loop reads
// status at the top of each iteration (so client-side stop() exits
// cleanly) and writes via the handlers defined below.
//
// Users never import this module directly; the `useHeartbeat(def)` hook
// wraps `useEntity(heartbeatStatus, ...)` on the client.

import { defineEntity } from './entity';
import { text, integer } from './schema';

const STATUS_VALUES = ['idle', 'running', 'done'] as const;
const TRIGGER_VALUES = ['boot', 'manual'] as const;

/**
 * Reserved entity name. The loader rejects user-defined entities with
 * this name so the framework has a stable handle.
 */
export const HEARTBEAT_STATUS_ENTITY_NAME = 'heartbeatStatus';

export const heartbeatStatus = defineEntity(HEARTBEAT_STATUS_ENTITY_NAME, {
    state: {
        status: text({ enum: STATUS_VALUES }),
        runNumber: integer(),
        lastRunAt: integer(),
        nextRunAt: integer(),
        errorCount: integer(),
        lastError: text(),
        stoppedByUser: integer(),           // 0 | 1 — persists across reboots
        trigger: text({ enum: TRIGGER_VALUES }),
        maxRuns: integer(),                 // 0 = unbounded
        // Session counter bumped on each idle/done → running transition.
        // Used as the Restate workflow invocation id so fresh starts after
        // stop() don't collide with Restate's workflow-per-key dedup
        // (workflows complete permanently in Restate — same key = rejected).
        sessionCounter: integer(),
        currentSession: text(),
    },
    transitions: {
        // 'idle' self-loops because reset() is idempotent — clicking
        // reset on an already-idle status is a legal no-op, not a
        // transition error.
        idle: ['idle', 'running'],
        // 'running' self-loops on every tick; exits to 'done' when
        // maxRuns is reached or 'idle' when the user stops.
        running: ['running', 'done', 'idle'],
        done: ['idle', 'running'],
    },
    handlers: {
        // Called once at the start of a workflow invocation. Idempotent:
        // concurrent arms from replica races serialize per entity key
        // and land on 'running → running' which no-ops.
        arm(state, trigger: 'boot' | 'manual', maxRuns: number) {
            if (state.status === 'running') return state;

            const nextCounter = (state.sessionCounter ?? 0) + 1;
            return {
                ...state,
                status: 'running' as const,
                runNumber: 0,
                lastRunAt: 0,
                nextRunAt: 0,
                errorCount: 0,
                lastError: '',
                stoppedByUser: 0,
                trigger,
                maxRuns,
                sessionCounter: nextCounter,
                currentSession: String(nextCounter),
            };
        },
        // Called by the workflow after each successful handler invocation.
        // No-ops if status is no longer 'running' (a stop() landed between
        // the work and the record).
        recordRun(state, runNumber: number, at: number, nextAt: number) {
            if (state.status !== 'running') return state;
            return { ...state, runNumber, lastRunAt: at, nextRunAt: nextAt };
        },
        // Called when the user handler throws. Loop continues on schedule.
        // Guarded by status — if a stop() raced with a handler throw, skip
        // the update so the idle entity doesn't carry stale error fields
        // that would surface in the UI after stop.
        recordError(state, runNumber: number, msg: string) {
            if (state.status !== 'running') return state;
            return {
                ...state,
                runNumber,
                errorCount: state.errorCount + 1,
                lastError: msg,
            };
        },
        // Called by the workflow when maxRuns is reached.
        finish(state) {
            return { ...state, status: 'done' as const };
        },
        // Client-initiated stop. Sets stoppedByUser so boot hooks don't
        // relaunch after a restart until reset() clears it.
        stop(state) {
            return { ...state, status: 'idle' as const, stoppedByUser: 1 };
        },
        // Full reset — zero counters and clear stoppedByUser so boot hooks
        // will re-invoke on the next reboot. Does not cancel an in-flight
        // workflow; clients should chain stop() first if they want a clean
        // slate.
        // Preserve sessionCounter across reset — it's a monotonic
        // uniqueness source for Restate workflow invocation ids and
        // must never roll back, or a post-reset arm() could generate a
        // token colliding with a prior completed workflow that Restate
        // still has on file. Only user-visible counters are cleared.
        reset(state) {
            return {
                ...state,
                status: 'idle' as const,
                runNumber: 0,
                lastRunAt: 0,
                nextRunAt: 0,
                errorCount: 0,
                lastError: '',
                stoppedByUser: 0,
                trigger: 'boot' as const,
                maxRuns: 0,
                currentSession: '',
            };
        },
    },
});

/** Key format used for lookups: `<heartbeat-name>/<scopeKey>`. */
export function heartbeatStatusKey(heartbeatName: string, scopeKey: string): string {
    return `${heartbeatName}/${scopeKey}`;
}
