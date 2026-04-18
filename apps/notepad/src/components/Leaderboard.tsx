import { authorHue } from '../lib/authorHue';

/**
 * Grouped DBSP view: notes per author, incrementally recomputed
 * server-side on every write and pushed down to every client. Pure
 * read — the component takes the view rows as a prop.
 */
export function Leaderboard({
  rows,
}: {
  rows: ReadonlyArray<{ readonly author: unknown; readonly count: unknown }>;
}) {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => Number(b.count) - Number(a.count)).slice(0, 5);
  const max = Math.max(...sorted.map((r) => Number(r.count)), 1);
  return (
    <section className="leaderboard">
      <h2>top authors</h2>
      <ul>
        {sorted.map((r) => {
          const author = String(r.author);
          const pct = (Number(r.count) / max) * 100;
          return (
            <li key={author}>
              <span className="bar-label" style={{ color: `hsl(${authorHue(author)}, 70%, 65%)` }}>
                {author}
              </span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: pct + '%', background: `hsl(${authorHue(author)}, 60%, 45%)` }} />
              </span>
              <span className="bar-count">{Number(r.count)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
