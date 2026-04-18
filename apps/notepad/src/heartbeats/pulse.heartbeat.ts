import { heartbeat } from '@syncengine/server';

/**
 * Heartbeats are the framework's primitive for durable recurring work.
 *
 * This file declares *what* should run and *how often* — the framework
 * handles scheduling, crash recovery, leader election across replicas,
 * and lifecycle state. No entity to hand-roll, no workflow loop to
 * write, no worker to kick off from the client.
 *
 * Key points to read off the config below:
 *
 *   - `trigger: 'manual'` means the client calls `start()` to launch it.
 *     Use `'boot'` (the default) for background jobs that should run
 *     automatically when a workspace comes up.
 *   - `every: '5s'` is the interval between ticks. Durations accept
 *     single units ('30s', '5m', '1h', '1d') or cron expressions.
 *   - `maxRuns: 12` bounds the run. Omit for unbounded.
 *   - `scope: 'workspace'` (default) runs one instance per workspace.
 *     Switch to `'global'` for a single cluster-wide loop.
 *
 * Ctrl-C `syncengine dev` mid-run and restart — the workflow resumes
 * on schedule. setInterval would have lost those ticks.
 */
export const pulse = heartbeat('pulse', {
  trigger: 'manual',
  scope: 'workspace',
  every: '5s',
  maxRuns: 12,
  run: async (ctx) => {
    // Each tick runs server-side on Restate. `ctx` is a full workflow
    // context (ctx.sleep, ctx.run, ctx.date.now, entityRef). The handler
    // can call entities, perform durable external calls, whatever you
    // need. For the demo we just let the framework track run numbers.
    void ctx;
  },
});
