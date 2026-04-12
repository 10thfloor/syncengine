// ── Client-side heartbeat hook ──────────────────────────────────────────────
//
// `useHeartbeat(def)` surfaces the framework-owned heartbeat-status entity
// to the UI, plus three lifecycle methods:
//
//   - start()  → arm the status entity; if the transition fires (not already
//                running), POST a Restate workflow invocation with the new
//                session token as the invocation id. Dedup'd by Restate's
//                workflow-per-key semantics.
//   - stop()   → call status.stop() — the scheduler loop observes the
//                status change at the top of its next iteration and exits.
//   - reset()  → call status.reset() — clears counters and stoppedByUser.

import { useCallback } from 'react';
import {
    heartbeatStatus,
    errors,
    ConnectionCode,
    HandlerCode,
} from '@syncengine/core';
import {
    useEntity,
    invokeHandler,
    getEntityClientWorkspace,
    getEntityClientAuthToken,
} from './entity-client';

/** Minimal structural type that matches what `heartbeat()` produces on the
 *  server and the vite-plugin stub emits for the client bundle. */
export interface HeartbeatRef {
    readonly $tag: 'heartbeat';
    readonly $name: string;
    readonly $scope: 'workspace' | 'global';
    readonly $trigger: 'boot' | 'manual';
    readonly $maxRuns: number;
    readonly $runAtStart: boolean;
}

export interface UseHeartbeatResult {
    readonly status: 'idle' | 'running' | 'done';
    readonly runNumber: number;
    readonly lastRunAt: number;
    readonly nextRunAt: number;
    readonly lastError: string | null;
    readonly errorCount: number;
    readonly ready: boolean;
    readonly start: () => Promise<void>;
    readonly stop: () => Promise<void>;
    readonly reset: () => Promise<void>;
}

/**
 * Subscribe to a heartbeat's status and control its lifecycle.
 *
 *     const pulse = useHeartbeat(pulseDef);
 *     pulse.status;       // 'idle' | 'running' | 'done'
 *     pulse.runNumber;    // last completed run within this session
 *     pulse.start();      // idempotent if already running
 *     pulse.stop();       // graceful exit at next iteration
 */
export function useHeartbeat(def: HeartbeatRef): UseHeartbeatResult {
    const statusKey = def.$name;
    const { state, ready } = useEntity(heartbeatStatus, statusKey);

    const start = useCallback(async () => {
        // Step 1: arm the status entity. Returns the new state — if we
        // actually transitioned, currentSession carries the fresh token.
        // If a concurrent tab armed first, we see the same session and
        // the workflow POST below dedups at the Restate layer.
        const armed = await invokeHandler(
            heartbeatStatus,
            statusKey,
            'arm',
            [def.$trigger, def.$maxRuns],
        );
        const sessionToken = String(armed.currentSession ?? '');
        if (!sessionToken) {
            throw errors.handler(HandlerCode.WORKFLOW_FAILED, {
                message: `heartbeat.start('${def.$name}'): arm() returned no session token.`,
                context: { heartbeat: def.$name },
            });
        }

        // Step 2: fire the workflow. Restate dedups on workflow key;
        // concurrent tabs with the same session token land on the same
        // existing invocation. Dedicated `/rpc/heartbeat/` route because
        // heartbeats register under a `heartbeat_` prefix (not `workflow_`).
        const wsKey = getEntityClientWorkspace();
        const url =
            `/__syncengine/rpc/heartbeat/${encodeURIComponent(def.$name)}` +
            `/${encodeURIComponent(sessionToken)}`;
        const headers: Record<string, string> = {
            'content-type': 'application/json',
            'x-syncengine-workspace': wsKey,
        };
        const authToken = getEntityClientAuthToken();
        if (authToken) headers.authorization = `Bearer ${authToken}`;

        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                scopeKey: wsKey,
                trigger: def.$trigger,
                maxRuns: def.$maxRuns,
                runAtStart: def.$runAtStart,
            }),
        });

        if (!res.ok) {
            // A 4xx from Restate usually means "workflow already running
            // with that key" — a benign no-op for us (Restate dedup). Log
            // but don't throw so start() stays idempotent.
            const text = await res.text().catch(() => '<no body>');
            if (res.status >= 500) {
                throw errors.connection(ConnectionCode.HTTP_ERROR, {
                    message: `heartbeat.start('${def.$name}') failed: ${res.status} ${text}`,
                    context: { heartbeat: def.$name, status: res.status },
                });
            }
        }
    }, [def.$name, def.$trigger, def.$maxRuns, def.$runAtStart, statusKey]);

    const stop = useCallback(async () => {
        await invokeHandler(heartbeatStatus, statusKey, 'stop', []);
    }, [statusKey]);

    const reset = useCallback(async () => {
        await invokeHandler(heartbeatStatus, statusKey, 'reset', []);
    }, [statusKey]);

    return {
        status: (state?.status as 'idle' | 'running' | 'done' | undefined) ?? 'idle',
        runNumber: Number(state?.runNumber ?? 0),
        lastRunAt: Number(state?.lastRunAt ?? 0),
        nextRunAt: Number(state?.nextRunAt ?? 0),
        lastError: state?.lastError ? String(state.lastError) : null,
        errorCount: Number(state?.errorCount ?? 0),
        ready,
        start,
        stop,
        reset,
    };
}
