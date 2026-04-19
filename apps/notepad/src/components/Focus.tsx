import { useState, useEffect } from 'react';
import { useStore } from '@syncengine/client';
import { focus } from '../entities/focus.actor';
import type { DB } from '../db';

/**
 * Server-side state-machine entity keyed per user so each participant
 * has their own focus state. The +30s button triggers a durable
 * pomodoro workflow via the entity's emit() effects — the domain
 * handler declares the side effect, the framework dispatches it.
 * No workflow orchestration in the UI.
 */
export function Focus({ userId }: { userId: string }) {
  const s = useStore<DB>();
  const { state, actions } = s.useEntity(focus, userId);
  const status = state?.status ?? 'idle';
  const topic = state?.topic ?? '';
  const endsAt = Number(state?.endsAt ?? 0);
  const [draft, setDraft] = useState('');

  // Tick once per second so the countdown updates while a pomodoro is running.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (status !== 'running' || endsAt <= 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status, endsAt]);

  function start(withPomodoroMs?: number) {
    const label = draft.trim();
    if (!label) return;
    const now = Date.now();
    const endsAt = withPomodoroMs ? now + withPomodoroMs : 0;
    // The entity handler triggers the pomodoro workflow via emit({ effects })
    // when endsAt > 0. No runWorkflow() needed — hex pattern in action.
    actions.start(label, now, endsAt);
    setDraft('');
  }

  if (status === 'running') {
    const remaining = endsAt > 0 ? Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) : null;
    return (
      <div className="focus">
        <span className="focus-label">{remaining !== null ? '🍅 pomodoro' : 'working on'}</span>
        <span className="focus-topic">{topic || 'something'}</span>
        {remaining !== null && (
          <span className="focus-countdown" title="durable Restate workflow">
            {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
          </span>
        )}
        <button onClick={() => actions.finish()}>done</button>
        <button className="ghost" onClick={() => actions.reset()}>cancel</button>
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="focus">
        <span className="focus-label">finished</span>
        <span className="focus-topic">{topic || 'a task'}</span>
        <button onClick={() => actions.reset()}>reset</button>
      </div>
    );
  }

  return (
    <div className="focus">
      <span className="focus-label">focus</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') start();
        }}
        placeholder="What are we working on?"
      />
      <button disabled={!draft.trim()} onClick={() => start()}>
        start
      </button>
      <button
        className="pomodoro"
        disabled={!draft.trim()}
        onClick={() => start(30_000)}
        title="Schedules a durable Restate workflow that auto-finishes in 30s — survives server restarts"
      >
        🍅 30s
      </button>
    </div>
  );
}
