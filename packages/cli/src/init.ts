/**
 * `syncengine init [dir]` — scaffold a shared notepad demo.
 *
 * Creates a ready-to-run app that demonstrates real-time sync:
 * open two browser tabs, type in one, see it in the other.
 *
 *   syncengine init my-app
 *   cd my-app
 *   syncengine dev
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { errors, CliCode } from '@syncengine/core';

// ── ANSI helpers ─────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const check = `  ${GREEN}✓${RESET}`;
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

// ── Package manager detection ────────────────────────────────────────────

type PM = 'pnpm' | 'npm' | 'yarn';

function detectPackageManager(target: string): PM {
    // 1. npm_config_user_agent (set when running via npx/pnpx/yarn dlx)
    const ua = process.env.npm_config_user_agent ?? '';
    if (ua.startsWith('pnpm/')) return 'pnpm';
    if (ua.startsWith('yarn/')) return 'yarn';
    if (ua.startsWith('npm/')) return 'npm';

    // 2. Walk up from target looking for lockfiles
    let dir = resolve(target);
    for (let i = 0; i < 10; i++) {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
        if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
        if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return 'pnpm';
        if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
        if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
    }

    // 3. Default
    return 'pnpm';
}

// ── Workspace detection (monorepo vs external) ───────────────────────────

function isInWorkspace(target: string): boolean {
    let dir = resolve(target);
    for (let i = 0; i < 10; i++) {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
        if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return true;
    }
    return false;
}

// ── Spinner ──────────────────────────────────────────────────────────────

function startSpinner(msg: string): { stop(finalMsg: string): void } {
    let frame = 0;
    const interval = setInterval(() => {
        process.stdout.write(`\r  ${YELLOW}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${RESET} ${msg}`);
        frame++;
    }, 80);

    return {
        stop(finalMsg: string) {
            clearInterval(interval);
            process.stdout.write(`\r${check} ${finalMsg}\x1b[K\n`);
        },
    };
}

// ── Install dependencies ─────────────────────────────────────────────────

async function installDeps(target: string, pm: PM): Promise<boolean> {
    const spinner = startSpinner('Installing dependencies...');

    return new Promise((resolve) => {
        const child = spawn(pm, ['install'], {
            cwd: target,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
        });

        child.on('close', (code) => {
            if (code === 0) {
                spinner.stop('Installed dependencies');
                resolve(true);
            } else {
                spinner.stop(`Install failed (exit ${code})`);
                resolve(false);
            }
        });

        child.on('error', () => {
            spinner.stop('Install failed');
            resolve(false);
        });
    });
}

// ── File writer ──────────────────────────────────────────────────────────

function write(dir: string, relPath: string, content: string): void {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
}

// ── Scaffold project ─────────────────────────────────────────────────────

function scaffoldProject(target: string, name: string, useWorkspace: boolean): void {
    const depVersion = useWorkspace ? 'workspace:*' : 'latest';

    // ── package.json
    write(target, 'package.json', JSON.stringify({
        name,
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: {
            dev: 'syncengine dev',
            build: 'syncengine build',
            start: 'syncengine start',
            test: 'vitest run',
        },
        dependencies: {
            '@syncengine/client': depVersion,
            '@syncengine/core': depVersion,
            'react': '^19.0.0',
            'react-dom': '^19.0.0',
        },
        devDependencies: {
            '@syncengine/vite-plugin': depVersion,
            '@syncengine/cli': depVersion,
            '@types/react': '^19.0.0',
            '@types/react-dom': '^19.0.0',
            '@vitejs/plugin-react': '^4.0.0',
            'typescript': '~5.9.0',
            'vite': '^6.0.0',
            'vite-plugin-wasm': '^3.0.0',
            'vite-plugin-top-level-await': '^1.0.0',
            'vitest': '^2.0.0',
        },
    }, null, 2));

    // ── vite.config.ts
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

    // ── syncengine.config.ts
    write(target, 'syncengine.config.ts', `\
import { defineConfig } from '@syncengine/core';

export default defineConfig({
  workspaces: {
    resolve: () => 'default',
  },
});
`);

    // ── index.html
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

    // ── src/main.tsx
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

    // ── src/schema.ts
    write(target, 'src/schema.ts', `\
import { table, id, text, integer, view, count } from '@syncengine/core';

export const notes = table('notes', {
  id: id(),
  body: text(),
  author: text(),
  createdAt: integer(),
});

export const stats = view(notes).aggregate([], {
  totalNotes: count(),
});

export const recentNotes = view(notes)
  .topN(notes.createdAt, 20, 'desc');
`);

    // ── src/App.tsx
    write(target, 'src/App.tsx', `\
import { useState, useMemo } from 'react';
import { store, useStore } from '@syncengine/client';
import { notes, stats, recentNotes } from './schema';

// ── Store ────────────────────────────────────────────────────────
export const db = store({
  tables: [notes] as const,
  views: { stats, recentNotes },
});

type DB = typeof db;

// ── Author color (deterministic hue from name) ──────────────────
function authorHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

// ── App ──────────────────────────────────────────────────────────
export default function App() {
  const s = useStore<DB>();
  const { views, ready } = s.use({ stats, recentNotes });
  const [input, setInput] = useState('');

  const userId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('user') ?? 'anon';
  }, []);

  const hue = authorHue(userId);
  const totalNotes = views.stats[0]?.totalNotes ?? 0;

  function handleSubmit() {
    const body = input.trim();
    if (!body) return;
    s.tables.notes.insert({ body, author: userId, createdAt: Date.now() });
    setInput('');
  }

  if (!ready) {
    return <div className="container"><p className="muted">Connecting...</p></div>;
  }

  return (
    <div className="container">
      <header>
        <h1>syncengine</h1>
        <div className="badges">
          <span className="badge" style={{ background: \`hsl(\${hue}, 70%, 40%)\` }}>
            {userId}
          </span>
          <span className="badge badge-muted">
            {totalNotes} note{totalNotes !== 1 ? 's' : ''}
          </span>
        </div>
      </header>

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

      <div className="feed">
        {views.recentNotes.map((n) => {
          const h = authorHue(String(n.author));
          return (
            <div key={String(n.id)} className="note-card">
              <span className="note-author" style={{ color: \`hsl(\${h}, 70%, 65%)\` }}>
                {String(n.author)}
              </span>
              <span className="note-body">{String(n.body)}</span>
              <span className="note-time">
                {new Date(Number(n.createdAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          );
        })}
        {views.recentNotes.length === 0 && (
          <p className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
            No notes yet. Type something above!
          </p>
        )}
      </div>

      <footer>
        Open another tab with{' '}
        <code>?user=bob</code>{' '}
        to see real-time sync.
      </footer>
    </div>
  );
}
`);

    // ── src/index.css
    write(target, 'src/index.css', `\
*, *::before, *::after { box-sizing: border-box; margin: 0; }

:root {
  color-scheme: dark;
  --bg: #09090b;
  --bg-card: #18181b;
  --border: #27272a;
  --fg: #fafafa;
  --muted: #71717a;
  --accent: #6366f1;
  --radius: 8px;
  --mono: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.container {
  max-width: 560px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

h1 {
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.badges { display: flex; gap: 0.4rem; }

.badge {
  font-family: var(--mono);
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 4px;
  color: white;
}

.badge-muted {
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--muted);
}

.input-row {
  margin-bottom: 1.5rem;
}

.input-row input {
  width: 100%;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.6rem 0.75rem;
  font-size: 0.9rem;
  color: var(--fg);
  outline: none;
  transition: border-color 0.15s;
}

.input-row input:focus {
  border-color: var(--accent);
}

.input-row input::placeholder {
  color: var(--muted);
}

.feed {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.note-card {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.85rem;
}

.note-author {
  font-family: var(--mono);
  font-size: 0.75rem;
  font-weight: 500;
  flex-shrink: 0;
}

.note-body {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.note-time {
  font-family: var(--mono);
  font-size: 0.7rem;
  color: var(--muted);
  flex-shrink: 0;
}

.muted { color: var(--muted); font-size: 0.85rem; }

footer {
  margin-top: 2.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
  font-size: 0.75rem;
  color: var(--muted);
  text-align: center;
}

footer code {
  font-family: var(--mono);
  background: var(--bg-card);
  padding: 1px 4px;
  border-radius: 3px;
}
`);

    // ── tsconfig.json
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

    // ── .gitignore
    write(target, '.gitignore', `\
node_modules
dist
.syncengine
*.local
`);
}

// ── Banner and output ────────────────────────────────────────────────────

function printHeader(name: string): void {
    const width = 43;
    const top    = `  ┌${'─'.repeat(width)}┐`;
    const bottom = `  └${'─'.repeat(width)}┘`;
    const pad = (s: string) => {
        const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
        return `  │  ${s}${' '.repeat(Math.max(0, width - 2 - visible.length))}│`;
    };

    process.stdout.write('\n');
    process.stdout.write(`${DIM}${top}${RESET}\n`);
    process.stdout.write(`${DIM}${pad('')}${RESET}\n`);
    process.stdout.write(`${DIM}${pad(`${BOLD}${CYAN}syncengine${RESET}`)}${RESET}\n`);
    process.stdout.write(`${DIM}${pad('')}${RESET}\n`);
    process.stdout.write(`${DIM}${pad(`Creating: ${BOLD}${name}${RESET}`)}${RESET}\n`);
    process.stdout.write(`${DIM}${pad('')}${RESET}\n`);
    process.stdout.write(`${DIM}${bottom}${RESET}\n`);
    process.stdout.write('\n');
}

function printSuccess(name: string, pm: PM): void {
    const bar = `  ${DIM}${'━'.repeat(43)}${RESET}`;
    const run = pm === 'npm' ? 'npx syncengine dev' : `${pm === 'yarn' ? 'yarn' : 'pnpm'} syncengine dev`;

    process.stdout.write(`\n${bar}\n\n`);
    process.stdout.write(`  ${BOLD}Your syncengine app is ready.${RESET}\n\n`);
    process.stdout.write(`    ${CYAN}cd${RESET} ${name}\n`);
    process.stdout.write(`    ${CYAN}${run}${RESET}\n\n`);
    process.stdout.write(`  ${DIM}Then open two browser tabs to see real-time sync.${RESET}\n\n`);
}

function printInstallFailed(pm: PM): void {
    process.stdout.write(`\n  ${DIM}Install failed. Run manually:${RESET}\n`);
    process.stdout.write(`    ${CYAN}${pm} install${RESET}\n\n`);
}

// ── Entry ────────────────────────────────────────────────────────────────

export async function initCommand(args: string[]): Promise<void> {
    const target = resolve(args[0] ?? '.');
    const name = basename(target);

    // Validate target directory
    if (existsSync(target)) {
        const contents = readdirSync(target);
        const nonDot = contents.filter((f) => !f.startsWith('.'));
        if (nonDot.length > 0) {
            throw errors.cli(CliCode.DIRECTORY_NOT_EMPTY, {
                message: `Directory ${target} is not empty.`,
                hint: 'Pick an empty directory or a new name.',
                context: { directory: target },
            });
        }
    }

    printHeader(name);

    // Scaffold
    mkdirSync(target, { recursive: true });
    const useWorkspace = isInWorkspace(target);
    scaffoldProject(target, name, useWorkspace);
    process.stdout.write(`${check} Scaffolded project files\n`);

    // Detect package manager
    const pm = detectPackageManager(target);
    process.stdout.write(`${check} Detected ${BOLD}${pm}${RESET}\n`);

    // Install
    const ok = await installDeps(target, pm);
    if (!ok) {
        printInstallFailed(pm);
        return;
    }

    printSuccess(name, pm);
}
