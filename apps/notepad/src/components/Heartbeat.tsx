import { useState, useEffect } from 'react';
import { useHeartbeat } from '@syncengine/client';
import { pulse } from '../heartbeats/pulse.heartbeat';

/**
 * `useHeartbeat(pulse)` subscribes to the framework-owned status
 * entity and returns the live state (status, runNumber, lastRunAt)
 * alongside lifecycle methods (start/stop/reset). No entity, workflow,
 * or client kick-off code to hand-roll.
 *
 * Crash-safe: kill `syncengine dev` mid-run, restart it, and ticks
 * resume on the original schedule. setInterval can't do this — its
 * timer dies with its process.
 */
export function Heartbeat() {
  const hb = useHeartbeat(pulse);
  const [, setNow] = useState(Date.now());

  // Keep "Ns ago" fresh.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const maxRuns = pulse.$maxRuns || 12;
  const sinceLast = hb.lastRunAt > 0 ? Math.floor((Date.now() - hb.lastRunAt) / 1000) : null;
  const pct = maxRuns > 0 ? Math.min(100, (hb.runNumber / maxRuns) * 100) : 0;

  return (
    <section className="heartbeat-wrap">
      <div className="heartbeat">
        <span className="focus-label">heartbeat</span>

        {hb.status === 'running' && (
          <>
            <span className="pulse-dot" />
            <span className="heartbeat-progress">
              tick {hb.runNumber} / {maxRuns}
            </span>
            <span className="heartbeat-bar">
              <span className="heartbeat-bar-fill" style={{ width: pct + '%' }} />
            </span>
            <span className="heartbeat-since muted">
              {sinceLast === null ? 'priming...' : sinceLast < 2 ? 'just now' : sinceLast + 's ago'}
            </span>
            <button className="ghost" onClick={() => hb.stop()}>stop</button>
          </>
        )}

        {hb.status === 'done' && (
          <>
            <span className="heartbeat-progress done">
              ✓ {hb.runNumber} pulses delivered
            </span>
            <button onClick={() => hb.start()}>run again</button>
            <button className="ghost" onClick={() => hb.reset()}>reset</button>
          </>
        )}

        {hb.status === 'idle' && (
          <>
            <span className="muted" style={{ flex: 1 }}>
              Declarative recurring heartbeat — {maxRuns} ticks × 5s
            </span>
            <button onClick={() => hb.start()}>start</button>
          </>
        )}
      </div>

      <p className="heartbeat-hint muted">
        {hb.status === 'running'
          ? 'Try this: Ctrl-C syncengine dev and restart. Ticks resume on schedule.'
          : 'Click start, then Ctrl-C syncengine dev mid-run and restart — setInterval would die, this heartbeat resumes.'}
      </p>
    </section>
  );
}
