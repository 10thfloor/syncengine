import { defineWorkflow, entityRef } from '@syncengine/server';
import { focus } from '../entities/focus.actor';

interface PomodoroInput {
  key: string;         // focus entity key — per-user, so client passes userId
  durationMs: number;  // how long to focus for
}

/**
 * Durable timer — Restate's killer feature.
 *
 * `ctx.sleep()` is checkpointed by Restate. You can kill the server
 * mid-sleep, restart it hours later, and the workflow resumes from the
 * same line honoring the original wall-clock deadline. Try it:
 *
 *   1. Click "pomodoro 30s" in the UI to schedule a finish.
 *   2. Ctrl-C `syncengine dev` and restart.
 *   3. Watch the focus session still complete on schedule.
 *
 * That durability is why you reach for a workflow instead of setTimeout:
 * nothing a client or server crash can do will skip or double-fire it.
 */
export const pomodoro = defineWorkflow('pomodoro', async (ctx, input: PomodoroInput) => {
  await ctx.sleep(input.durationMs);

  // Ref the focus entity by key; the finish() handler advances status.
  // If the user reset the session while we slept, the transition guard
  // rejects the call — we swallow it so the workflow exits cleanly.
  const f = entityRef(ctx, focus, input.key);
  try {
    await f.finish();
  } catch {
    // User cancelled the focus mid-pomodoro — nothing to do.
  }
});
