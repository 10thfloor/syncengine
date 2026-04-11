/**
 * `syncengine init [dir]` — scaffold a minimal starter project.
 *
 * Generates a ready-to-run syncengine app with:
 *   - package.json (deps on @syncengine/client, core, vite-plugin)
 *   - vite.config.ts (wired up with WASM + React + syncengine plugin)
 *   - syncengine.config.ts (default resolver)
 *   - index.html (minimal shell)
 *   - src/main.tsx (React entry with StoreProvider)
 *   - src/App.tsx (hello-world with a counter entity)
 *   - src/entities/counter.actor.ts (minimal entity)
 *   - src/index.css (dark theme baseline)
 *   - tsconfig.json + tsconfig.app.json
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

import { banner, note } from './runner';
import { errors, CliCode } from '@syncengine/core';

export async function initCommand(args: string[]): Promise<void> {
    const target = resolve(args[0] ?? '.');
    const name = basename(target);

    if (existsSync(target)) {
        const contents = readdirSync(target);
        // Allow empty dirs or dirs with only dotfiles
        const nonDot = contents.filter((f) => !f.startsWith('.'));
        if (nonDot.length > 0) {
            throw errors.cli(CliCode.DIRECTORY_NOT_EMPTY, {
                message: `Directory ${target} is not empty. Pick an empty directory or a new name.`,
                context: { directory: target },
            });
        }
    }

    banner(`creating syncengine project: ${name}`);

    mkdirSync(join(target, 'src', 'entities'), { recursive: true });

    // ── package.json ──────────────────────────────────────────────────
    write(target, 'package.json', JSON.stringify({
        name,
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: {
            dev: 'syncengine dev',
            build: 'syncengine build',
            start: 'syncengine start',
        },
        dependencies: {
            '@syncengine/client': 'workspace:*',
            '@syncengine/core': 'workspace:*',
            'react': '^19.0.0',
            'react-dom': '^19.0.0',
        },
        devDependencies: {
            '@syncengine/vite-plugin': 'workspace:*',
            '@syncengine/cli': 'workspace:*',
            '@types/react': '^19.0.0',
            '@types/react-dom': '^19.0.0',
            '@vitejs/plugin-react': '^4.0.0',
            'typescript': '~5.9.0',
            'vite': '^6.0.0',
            'vite-plugin-wasm': '^3.0.0',
            'vite-plugin-top-level-await': '^1.0.0',
        },
    }, null, 2));

    // ── vite.config.ts ────────────────────────────────────────────────
    write(target, 'vite.config.ts', `\
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import syncengine from '@syncengine/vite-plugin';

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    syncengine(),
    react(),
  ],
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  build: { target: 'esnext' },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
});
`);

    // ── syncengine.config.ts ──────────────────────────────────────────
    write(target, 'syncengine.config.ts', `\
import { defineConfig } from '@syncengine/core';

export default defineConfig({
  workspaces: {
    resolve: ({ request }) => {
      const url = new URL(request.url);
      return \`user:\${url.searchParams.get('user') ?? 'anon'}\`;
    },
  },
});
`);

    // ── index.html ────────────────────────────────────────────────────
    write(target, 'index.html', `\
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`);

    // ── src/main.tsx ──────────────────────────────────────────────────
    write(target, 'src/main.tsx', `\
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from '@syncengine/client';
import App, { db } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider store={db}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
`);

    // ── src/App.tsx ───────────────────────────────────────────────────
    write(target, 'src/App.tsx', `\
import { useState } from 'react';
import { store, table, id, integer, text, view, sum, count, channel, useStore } from '@syncengine/client';
import { counter } from './entities/counter.actor';

// ── Schema ───────────────────────────────────────────────────────

const clicks = table('clicks', {
  id: id(),
  label: text(),
  amount: integer(),
});

const notes = table('notes', {
  id: id(),
  author: text(),
  body: text(),
});

const totalsView = view(clicks).aggregate([], {
  total: sum(clicks.amount),
  numClicks: count(),
});

const notesList = view(notes).distinct();

// ── Store ────────────────────────────────────────────────────────
// Tables not assigned to an explicit channel() get their own
// JetStream subject automatically. Use channel() to group tables
// that should sync together.
export const db = store({
  tables: [clicks, notes] as const,
  views: [totalsView, notesList],
  channels: [channel('main', [clicks]), channel('notes', [notes])],
});

type DB = typeof db;

// ── App ──────────────────────────────────────────────────────────
export default function App() {
  const s = useStore<DB>();
  const { views, ready } = s.useView({ totalsView, notesList });
  const total = views.totalsView[0]?.total ?? 0;
  const numClicks = views.totalsView[0]?.numClicks ?? 0;
  const [noteText, setNoteText] = useState('');

  const { state, actions } = s.useEntity(counter, 'global');

  if (!ready) return <div style={{ padding: '2rem' }}>Connecting...</div>;

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>syncengine</h1>

      <section>
        <h2>Counter entity</h2>
        <p>Server value: <strong>{state?.value ?? '...'}</strong></p>
        <button onClick={() => actions.increment(1)}>+1</button>
        <button onClick={() => actions.decrement(1)}>-1</button>
        <button onClick={() => actions.reset()}>reset</button>
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Clicks (DBSP incremental view)</h2>
        <p>{numClicks} clicks, total: <strong>{total}</strong></p>
        <button onClick={() => s.tables.clicks.insert({ label: 'click', amount: 1 })}>
          +1
        </button>
        <button onClick={() => s.tables.clicks.insert({ label: 'big click', amount: 10 })}>
          +10
        </button>
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Notes (separate channel)</h2>
        <p style={{ color: '#737373', fontSize: '0.85rem' }}>
          Syncs on its own JetStream subject, independent of clicks.
        </p>
        <input
          type="text"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && noteText.trim()) {
              s.tables.notes.insert({ author: 'me', body: noteText.trim() });
              setNoteText('');
            }
          }}
          placeholder="Type a note and press Enter..."
          style={{ width: '100%', padding: '0.4rem', marginTop: '0.5rem' }}
        />
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '0.5rem' }}>
          {views.notesList.map((n) => (
            <li key={String(n.id)} style={{ padding: '0.3rem 0' }}>
              <strong>{String(n.author)}</strong> {String(n.body)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
`);

    // ── src/entities/counter.actor.ts ─────────────────────────────────
    write(target, 'src/entities/counter.actor.ts', `\
import { entity, integer } from '@syncengine/core';

export const counter = entity('counter', {
  state: {
    value: integer(),
  },
  handlers: {
    increment: (state, amount: number) => ({
      ...state,
      value: state.value + amount,
    }),
    decrement: (state, amount: number) => ({
      ...state,
      value: state.value - amount,
    }),
    reset: (state) => ({
      ...state,
      value: 0,
    }),
  },
});
`);

    // ── src/index.css ─────────────────────────────────────────────────
    write(target, 'src/index.css', `\
*, *::before, *::after { box-sizing: border-box; margin: 0; }

:root {
  color-scheme: dark;
  --bg: #0a0a0a;
  --fg: #e5e5e5;
  --muted: #737373;
  --accent: #6366f1;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, sans-serif;
  line-height: 1.6;
}

button {
  background: var(--accent);
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  margin-right: 0.5rem;
}

button:hover { opacity: 0.9; }
button:active { transform: scale(0.98); }

h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
h2 { font-size: 1.1rem; color: var(--muted); margin-bottom: 0.5rem; }
section { margin-bottom: 2rem; }
`);

    // ── tsconfig.json ─────────────────────────────────────────────────
    write(target, 'tsconfig.json', JSON.stringify({
        compilerOptions: {
            target: 'ES2023',
            lib: ['ES2023', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            jsx: 'react-jsx',
            noEmit: true,
        },
        include: ['src', 'syncengine.config.ts', 'vite.config.ts'],
    }, null, 2));

    note('package.json');
    note('vite.config.ts');
    note('syncengine.config.ts');
    note('index.html');
    note('src/main.tsx');
    note('src/App.tsx');
    note('src/entities/counter.actor.ts');
    note('src/index.css');
    note('tsconfig.json');

    banner('done');
    process.stdout.write(`
  Next steps:

    cd ${name}
    pnpm install
    pnpm dev

`);
}

function write(dir: string, relPath: string, content: string): void {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
}
