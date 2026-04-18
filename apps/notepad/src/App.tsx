import { useState, useMemo } from 'react';
import { useStore } from '@syncengine/client';
import { stats, recentNotes, allThumbs, notesByAuthor } from './schema';
import { authorHue } from './lib/authorHue';
import type { DB } from './db';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { Presence } from './components/Presence';
import { Focus } from './components/Focus';
import { NoteFeed } from './components/NoteFeed';
import { Leaderboard } from './components/Leaderboard';
import { Heartbeat } from './components/Heartbeat';

export default function App() {
  const s = useStore<DB>();
  const { views, ready } = s.use({ stats, recentNotes, allThumbs, notesByAuthor });
  const [input, setInput] = useState('');

  const userId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('user') ?? 'anon';
  }, []);

  const hue = authorHue(userId);
  const totalNotes = views.stats[0]?.totalNotes ?? 0;

  // Index thumbs by noteId once per render. Local scan over SQLite-backed
  // view rows — no network, no subscription overhead.
  const thumbsByNote = useMemo(() => {
    const map = new Map<number, Array<{ id: number; userId: string }>>();
    for (const t of views.allThumbs) {
      const noteId = Number(t.noteId);
      const arr = map.get(noteId) ?? [];
      arr.push({ id: Number(t.id), userId: String(t.userId) });
      map.set(noteId, arr);
    }
    return map;
  }, [views.allThumbs]);

  function handleSubmit() {
    const body = input.trim();
    if (!body) return;
    s.tables.notes.insert({ body, author: userId, createdAt: Date.now() });
    setInput('');
  }

  function toggleThumb(noteId: number) {
    const mine = (thumbsByNote.get(noteId) ?? []).find((t) => t.userId === userId);
    if (mine) s.tables.thumbs.remove(mine.id);
    else s.tables.thumbs.insert({ noteId, userId });
  }

  if (!ready) {
    return <div className="container"><p className="muted">Connecting...</p></div>;
  }

  return (
    <div className="container">
      <header>
        <h1>syncengine</h1>
        <div className="badges">
          <WorkspaceSwitcher />
          <span className="badge" style={{ background: `hsl(${hue}, 70%, 40%)` }}>
            {userId}
          </span>
          <span className="badge badge-muted">
            {totalNotes} note{totalNotes !== 1 ? 's' : ''}
          </span>
        </div>
      </header>

      <Presence userId={userId} hue={hue} />
      <Focus userId={userId} />

      <div className="input-row">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Type a note and press Enter..."
          autoFocus
        />
      </div>

      <NoteFeed
        notes={views.recentNotes}
        thumbsByNote={thumbsByNote}
        userId={userId}
        onToggleThumb={toggleThumb}
      />

      <Leaderboard rows={views.notesByAuthor} />
      <Heartbeat />

      <footer>
        Open another tab with{' '}
        <code>?user=bob</code>{' '}
        to see real-time sync. Switch workspaces with{' '}
        <code>?workspace=team-b</code>.
      </footer>
    </div>
  );
}
