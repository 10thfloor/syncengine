/**
 * `syncengine init [dir]` — scaffold a minimal starter.
 *
 * Ships the three primitives that showcase the framework in the smallest
 * possible surface area:
 *   - `table` + `view` — durable, reactive, replicated state
 *   - `topic`          — ephemeral pub/sub (presence, cursors, typing)
 *
 * Open two tabs, type in one, see it in the other — and see the other
 * tab's peer bubble light up in the header. ~70 lines of app code.
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

    return new Promise((done) => {
        const child = spawn(pm, ['install'], {
            cwd: target,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
        });

        child.on('close', (code) => {
            if (code === 0) {
                spinner.stop('Installed dependencies');
                done(true);
            } else {
                spinner.stop(`Install failed (exit ${code})`);
                done(false);
            }
        });

        child.on('error', () => {
            spinner.stop('Install failed');
            done(false);
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
  plugins: [wasm(), topLevelAwait(), syncengine(), react()],
  worker: { format: 'es', plugins: () => [wasm(), topLevelAwait()] },
  build: { target: 'esnext' },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
});
`);

    // ── syncengine.config.ts
    write(target, 'syncengine.config.ts', `\
import { defineConfig } from '@syncengine/core';

/**
 * Workspaces = hard tenant isolation. Each wsKey gets its own NATS stream,
 * SQLite replica, and entity state — no cross-tenant leakage, no \`WHERE
 * tenant_id = ?\` on every query, no row-level-security rubber-stamping.
 *
 * Return any stable string (org id, tenant slug, URL segment). syncengine
 * hashes it to a bounded wsKey internally. Swap this resolver for your
 * auth context later; the demo just reads \`?workspace=\` from the URL:
 *
 *   http://localhost:5173/?workspace=alice
 *   http://localhost:5173/?workspace=bob   ← fully isolated from alice
 */
export default defineConfig({
  workspaces: {
    resolve: ({ request }) => {
      const url = new URL(request.url);
      return url.searchParams.get('workspace') ?? 'default';
    },
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
import App from './App';
import { db } from './db';
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
import { table, id, text, integer, view, topic } from '@syncengine/core';

/**
 * TABLE — durable, replicated, reactive state.
 *
 * Every connected client keeps a full SQLite replica of this log. Writes
 * merge via CRDT so offline edits reconcile on reconnect; queries run
 * on-device with zero round trips.
 *
 * Replaces: Postgres + a replication daemon + a websocket fan-out service
 * + a client-side cache + the retry/reconcile logic you write by hand.
 */
export const messages = table('messages', {
  id: id(),
  body: text(),
  author: text(),
  createdAt: integer(),
});

/**
 * VIEW — DBSP-compiled incremental query.
 *
 * Recomputed server-side on every write as a diff, pushed to every
 * subscriber. No polling, no cache invalidation, no denormalized read
 * model to keep in sync. Cost scales with the change-set, not the dataset.
 *
 * Replaces: materialized views + a refresh job + a cache + a pub/sub
 * invalidation bus + the "did I remember to bust this cache?" oncall page.
 */
export const recentMessages = view(messages).topN(messages.createdAt, 50, 'desc');

/**
 * TOPIC — ephemeral pub/sub over NATS core.
 *
 * Zero persistence, no replay, no CRDT. Each tab publishes its own payload;
 * peers hold a reactive map keyed by sender id, and the framework reaps
 * stale publishers automatically on disconnect.
 *
 * Replaces: Redis pub/sub + a sticky-session websocket fleet + connection
 * tracking + TTL sweeping + the presence bugs you ship and then forget.
 */
export const presence = topic('presence', {
  userId: text(),
  color: text(),
});

/**
 * Not wired into this starter, but available when you need them — same
 * declarative shape, same workspace isolation, same reactive client:
 *
 *   entity    — durable server state with state-machine transition guards
 *               (replaces hand-rolled state machines over Postgres rows)
 *   workflow  — durable long-running execution with ctx.sleep / ctx.run
 *               (replaces Temporal / Airflow / "cron + queue + DB table")
 *   heartbeat — declarative recurring jobs with leader election across
 *               replicas (replaces a cron container + a distributed lock)
 *   webhook   — inbound HTTP with signature verification + idempotency
 *               (replaces your bespoke webhook ingestion microservice)
 *   bus / channel — typed event routing between workspaces and services
 *
 * See the \`apps/notepad\` showcase in the syncengine repo for all of these
 * wired together in one app.
 */
`);

    // ── src/db.ts
    write(target, 'src/db.ts', `\
import { store } from '@syncengine/client';
import { messages, recentMessages } from './schema';

/**
 * One store per page load. Every React hook (useView / useTopic / …) reads
 * from here. The store owns the SQLite replica in a Web Worker, the DBSP
 * WASM runtime, and the NATS connection — you render off it and that's it.
 */
export const db = store({
  tables: [messages] as const,
  views: { recentMessages },
});

export type DB = typeof db;
`);

    // ── src/App.tsx
    write(target, 'src/App.tsx', `\
import { useState, useEffect, useMemo } from 'react';
import { useStore } from '@syncengine/client';
import { presence, recentMessages } from './schema';
import type { DB } from './db';

/**
 * Two primitives, one screen:
 *
 *   - \`recentMessages\` (view over the \`messages\` table) drives the feed.
 *     Type in one tab, appears in all tabs / all peers / after a refresh.
 *   - \`presence\` (topic) drives the peer bubbles in the header. Vanishes
 *     the moment a peer closes its tab — no persistence, no cleanup job.
 *
 * Try it:  http://localhost:5173/?user=alice
 *          http://localhost:5173/?user=bob
 *          http://localhost:5173/?workspace=team-b   (isolated tenant)
 */
export default function App() {
  const s = useStore<DB>();
  const { views, ready } = s.useView({ recentMessages });
  const [draft, setDraft] = useState('');

  const params = new URLSearchParams(window.location.search);
  const userId = useMemo(
    () => params.get('user') ?? 'anon-' + Math.random().toString(36).slice(2, 5),
    [],
  );
  const workspace = params.get('workspace') ?? 'default';
  const myColor = \`hsl(\${hashHue(userId)}, 70%, 55%)\`;

  // Ephemeral presence — publish once, framework auto-reaps peers on disconnect.
  const { peers, publish } = s.useTopic(presence, 'lobby');
  useEffect(() => { publish({ userId, color: myColor }); }, [userId, myColor, publish]);

  function send() {
    const body = draft.trim();
    if (!body) return;
    s.tables.messages.insert({ body, author: userId, createdAt: Date.now() });
    setDraft('');
  }

  if (!ready) return <div className="app"><p className="muted">Connecting…</p></div>;

  return (
    <div className="app">
      <header>
        <h1>syncengine</h1>
        <div className="meta">
          <span className="badge">workspace <code>{workspace}</code></span>
          <span className="badge you" style={{ background: myColor }}>{userId}</span>
          {Array.from(peers.values()).map((p) => (
            <span key={String(p.userId)} className="badge peer" style={{ background: String(p.color) }}>
              {String(p.userId)}
            </span>
          ))}
        </div>
      </header>

      <input
        className="compose"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && send()}
        placeholder="Type a message and press Enter…"
        autoFocus
      />

      <ul className="feed">
        {views.recentMessages.map((m) => (
          <li key={String(m.id)}>
            <span className="author" style={{ color: \`hsl(\${hashHue(String(m.author))}, 70%, 65%)\` }}>
              {String(m.author)}
            </span>
            <span className="body">{String(m.body)}</span>
            <time>
              {new Date(Number(m.createdAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          </li>
        ))}
      </ul>

      <footer>
        Open another tab with <code>?user=bob</code> for presence + sync.
        Add <code>&amp;workspace=team-b</code> for an isolated tenant.
      </footer>
    </div>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
`);

    // ── src/index.css
    write(target, 'src/index.css', `\
*, *::before, *::after { box-sizing: border-box; margin: 0; }

:root {
  color-scheme: dark;
  --bg: #0b0b0d;
  --card: #17171b;
  --border: #26262c;
  --fg: #ececf0;
  --muted: #8a8a93;
  --accent: #6366f1;
  --mono: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

.app { max-width: 620px; margin: 0 auto; padding: 2rem 1.25rem; }

header { display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1.25rem; }

h1 { font-size: 1.1rem; font-weight: 600; letter-spacing: -0.01em; }

.meta { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }

.badge {
  font-family: var(--mono);
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--muted);
}

.badge code { color: var(--fg); font-family: inherit; }

.badge.you, .badge.peer { color: white; border-color: transparent; }
.badge.peer { opacity: 0.88; }

.compose {
  width: 100%;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.65rem 0.8rem;
  font-size: 0.95rem;
  color: var(--fg);
  outline: none;
  transition: border-color 0.15s;
  margin-bottom: 1rem;
}

.compose:focus { border-color: var(--accent); }
.compose::placeholder { color: var(--muted); }

.feed { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }

.feed li {
  display: flex;
  align-items: baseline;
  gap: 0.55rem;
  padding: 0.45rem 0.75rem;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 0.88rem;
}

.author { font-family: var(--mono); font-size: 0.72rem; font-weight: 500; flex-shrink: 0; }

.body { flex: 1; min-width: 0; word-break: break-word; }

time { font-family: var(--mono); font-size: 0.68rem; color: var(--muted); flex-shrink: 0; }

.muted { color: var(--muted); }

footer {
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  font-size: 0.75rem;
  color: var(--muted);
  text-align: center;
}

footer code {
  font-family: var(--mono);
  background: var(--card);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--fg);
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

    // ── Dockerfile (single-process / \`syncengine start\` deployment)
    //
    // Kept in sync with apps/test/Dockerfile — that file is the canonical
    // reference exercised by scripts/smoke-docker.sh. If you change one,
    // change the other.
    write(target, 'Dockerfile', `\
# Production image — packages the \`syncengine build\` output behind a
# slim Node runtime. The bundled dist/server/index.mjs starts both the
# Restate H2C endpoint (:9080) and the HTTP server (:3000) in-process.
#
# Usage:
#   syncengine build
#   docker build -t ${name} .
#   docker run -p 3000:3000 -e SYNCENGINE_NATS_URL=... -e SYNCENGINE_RESTATE_URL=... ${name}

FROM node:22-bookworm-slim
WORKDIR /app

COPY --chown=node:node dist/ ./dist/
USER node

ENV HTTP_PORT=3000 \\
    PORT=9080

EXPOSE 3000 9080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \\
  CMD node -e "fetch('http://localhost:'+process.env.HTTP_PORT+'/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.mjs"]
`);

    // ── Dockerfile.handlers (scale-out / handlers-only tier)
    write(target, 'Dockerfile.handlers', `\
# Handlers image for the scale-out topology — Node bundle with
# SYNCENGINE_HANDLERS_ONLY=1 so the built-in HTTP server is skipped.
# The process only registers handlers with Restate; all browser-facing
# traffic is owned by a separate edge tier (syncengine-serve).

FROM node:22-bookworm-slim
WORKDIR /app

COPY --chown=node:node dist/ ./dist/
USER node

ENV PORT=9080 \\
    SYNCENGINE_HANDLERS_ONLY=1

EXPOSE 9080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \\
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/discover').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.mjs"]
`);

    // ── .dockerignore
    write(target, '.dockerignore', `\
# Only dist/ is actually COPY-ed (see Dockerfile). Everything else is
# excluded defensively so a sibling .env, source checkout, or stray
# node_modules can never land in the build context / image layer.

**
!dist/
!dist/**
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

function printSuccess(dir: string, pm: PM): void {
    const bar = `  ${DIM}${'━'.repeat(43)}${RESET}`;
    const run = pm === 'npm' ? 'npm run dev' : `${pm} dev`;

    process.stdout.write(`\n${bar}\n\n`);
    process.stdout.write(`  ${BOLD}Your syncengine app is ready.${RESET}\n\n`);
    process.stdout.write(`    ${CYAN}cd${RESET} ${dir}\n`);
    process.stdout.write(`    ${CYAN}${run}${RESET}\n\n`);
    process.stdout.write(`  ${DIM}Then open two browser tabs to see real-time sync.${RESET}\n\n`);
}

function printInstallFailed(pm: PM): void {
    process.stdout.write(`\n  ${DIM}Install failed. Run manually:${RESET}\n`);
    process.stdout.write(`    ${CYAN}${pm} install${RESET}\n\n`);
}

// ── Entry ────────────────────────────────────────────────────────────────

export async function initCommand(args: string[]): Promise<void> {
    const rawArg = args[0] ?? '.';
    const target = resolve(rawArg);
    const name = basename(target);
    // Show whatever the user typed for `cd`, so absolute paths and `.` round-trip faithfully.
    const cdArg = rawArg === '.' ? name : rawArg;

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

    printSuccess(cdArg, pm);
}
