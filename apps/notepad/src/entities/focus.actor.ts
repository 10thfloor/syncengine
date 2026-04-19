import { defineEntity, text, integer, emit, trigger } from '@syncengine/core';
import { pomodoro } from '../workflows/pomodoro.workflow';

/**
 * Tables vs entities — the core mental model.
 *
 * Tables (see `notes`, `thumbs` in schema.ts) are local state you
 * also sync. Every client keeps a full replica of the log, queries run
 * on-device in SQLite, and offline writes merge back in via CRDT.
 *
 * Entities are server state you subscribe to. The authoritative value
 * lives on a Restate virtual object, handlers execute serialized there,
 * and clients receive snapshots. No CRDT merge — the server is the
 * arbiter, so state machines and atomic counters stay exact no matter
 * how many tabs are writing.
 *
 * Rule of thumb:
 *   - table  → data you own and want offline / queryable locally
 *   - entity → shared state the server needs to referee
 *
 * This file is the state-machine flavor:
 *
 *   idle → running → done → idle
 *
 * `transitions` declares the legal edges. Restate rejects any handler
 * that tries to set `status` to a value that isn't reachable from the
 * current one; the same guard runs client-side, so the UI can't invent
 * illegal actions. You get server-validated state transitions for free
 * — what you'd reach for to model workflows, checkout flows, ticket
 * status, game rounds, etc.
 *
 * The pomodoro workflow is triggered via `emit({ effects })` when a
 * deadline is set. The entity handler stays pure — it declares the
 * intent, the framework dispatches the workflow after state persists.
 * This is the hex pattern: domain logic triggers side effects through
 * declared effects, not inline orchestration.
 */
const STATUS = ['idle', 'running', 'done'] as const;

export const focus = defineEntity('focus', {
  state: {
    status: text({ enum: STATUS }),
    topic: text(),
    startedAt: integer(),
    endsAt: integer(),  // 0 = no scheduled end; >0 = pomodoro deadline
  },
  transitions: {
    idle:    ['running'],
    running: ['done', 'idle'],
    done:    ['idle'],
  },
  handlers: {
    start(state, topic: string, now: number, endsAt: number) {
      const next = { ...state, status: 'running' as const, topic, startedAt: now, endsAt };

      // If a deadline is set, trigger the pomodoro workflow to auto-finish.
      // The entity handler stays pure — emit() declares the side effect,
      // the framework dispatches the workflow after state is persisted.
      if (endsAt > 0) {
        return emit({
          state: next,
          effects: [
            trigger(pomodoro, { key: '$key', durationMs: endsAt - now }),
          ],
        });
      }

      return next;
    },
    finish(state) {
      return { ...state, status: 'done' as const };
    },
    reset() {
      return { status: 'idle' as const, topic: '', startedAt: 0, endsAt: 0 };
    },
  },
});
