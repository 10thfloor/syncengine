import { useEffect } from 'react';
import { useStore } from '@syncengine/client';
import { presence } from '../topics/presence.topic';
import type { DB } from '../db';

/**
 * Ephemeral "who's here" strip, powered by a NATS-core topic. Each
 * tab publishes its userId + color on mount and leaves on unmount —
 * no DB writes, no Restate calls. Peers naturally disappear from the
 * list when they close their tab (TTL-reaped by the framework).
 */
export function Presence({ userId, hue }: { userId: string; hue: number }) {
  const s = useStore<DB>();
  const { peers, publish, leave } = s.useTopic(presence, 'global');

  useEffect(() => {
    publish({ userId, color: `hsl(${hue}, 70%, 50%)` });
    const interval = setInterval(() => publish({ userId, color: `hsl(${hue}, 70%, 50%)` }), 5000);
    const onLeave = () => leave();
    window.addEventListener('beforeunload', onLeave);
    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', onLeave);
      leave();
    };
  }, [userId, hue, publish, leave]);

  const others = Array.from(peers.values()).filter((p) => p.userId !== userId);
  if (others.length === 0) {
    return (
      <div className="presence">
        <span className="focus-label">live</span>
        <span className="muted">just you — open another tab to see presence</span>
      </div>
    );
  }
  return (
    <div className="presence">
      <span className="focus-label">live</span>
      {others.map((p) => (
        <span key={String(p.userId)} className="peer-dot" title={String(p.userId)} style={{ background: String(p.color) }}>
          {String(p.userId)}
        </span>
      ))}
    </div>
  );
}
