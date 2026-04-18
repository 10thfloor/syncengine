import { authorHue } from '../lib/authorHue';

/**
 * The main note feed + thumbs-up control. One row per note; the
 * thumbs-up button toggles a per-user row in the `thumbs` table,
 * driving the count badge reactively.
 */
export function NoteFeed({
  notes,
  thumbsByNote,
  userId,
  onToggleThumb,
}: {
  notes: ReadonlyArray<{ readonly id: unknown; readonly author: unknown; readonly body: unknown; readonly createdAt: unknown }>;
  thumbsByNote: ReadonlyMap<number, Array<{ id: number; userId: string }>>;
  userId: string;
  onToggleThumb: (noteId: number) => void;
}) {
  if (notes.length === 0) {
    return (
      <div className="feed">
        <p className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
          No notes yet. Type something above!
        </p>
      </div>
    );
  }

  return (
    <div className="feed">
      {notes.map((n) => {
        const h = authorHue(String(n.author));
        const noteId = Number(n.id);
        const rows = thumbsByNote.get(noteId) ?? [];
        const thumbCount = rows.length;
        const thumbed = rows.some((t) => t.userId === userId);
        return (
          <div key={String(n.id)} className="note-card">
            <span className="note-author" style={{ color: `hsl(${h}, 70%, 65%)` }}>
              {String(n.author)}
            </span>
            <span className="note-body">{String(n.body)}</span>
            <button
              className={`thumb ${thumbed ? 'thumbed' : ''}`}
              onClick={() => onToggleThumb(noteId)}
              title={thumbed ? 'remove thumbs-up' : 'thumbs-up'}
            >
              👍{thumbCount > 0 && <span className="thumb-count">{thumbCount}</span>}
            </button>
            <span className="note-time">
              {new Date(Number(n.createdAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        );
      })}
    </div>
  );
}
