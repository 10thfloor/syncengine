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
            test: 'vitest run',
        },
        dependencies: {
            '@syncengine/client': depVersion,
            '@syncengine/core': depVersion,
            '@syncengine/server': depVersion,
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
    // Return the workspace id for this request. Any stable string works
    // ('user:' + user.id, 'org:' + orgId, a URL path segment, etc.) —
    // syncengine hashes it to a bounded wsKey internally.
    //
    // The demo uses ?workspace=<name> so you can open two tabs at
    // http://localhost:5173/?workspace=alice to see real-time sync.
    resolve: ({ request, user }) => {
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

// Per-message thumbs-up. Each row = one thumbs-up by one user on one note.
// Toggling a thumb inserts or removes a row; counts fall out of a view.
export const thumbs = table('thumbs', {
  id: id(),
  noteId: integer(),
  userId: text(),
});

// Every thumbs-up row (unaggregated). The UI derives per-note counts and
// "did I already thumb this?" by filtering this locally — it's a SQLite
// replica so the scan is cheap.
export const allThumbs = view(thumbs);

// Grouped aggregate — one row per author with their running note count.
// DBSP recomputes each group incrementally, so a million notes stay cheap.
export const notesByAuthor = view(notes).aggregate([notes.author], {
  count: count(),
});
`);

    // ── src/entities/focus.actor.ts
    write(target, 'src/entities/focus.actor.ts', `\
import { defineEntity, text, integer } from '@syncengine/core';

/**
 * Tables vs entities — the core mental model.
 *
 * Tables (see \`notes\`, \`thumbs\` in schema.ts) are local state you
 * also sync. Every client keeps a full replica of the log, queries run
 * on-device in SQLite, and offline writes merge back in via CRDT.
 *
 * Entities are server state you subscribe to. The authoritative value
 * lives on a Restate virtual object, handlers execute serialized there,
 * and clients receive snapshots. No CRDT merge — the server is the
 * arbiter, so state machines and atomic counters stay exact no matter
 * how many tabs are writing.
 *
 * Rule of thumb:
 *   - table  → data you own and want offline / queryable locally
 *   - entity → shared state the server needs to referee
 *
 * This file is the state-machine flavor:
 *
 *   idle → running → done → idle
 *
 * \`transitions\` declares the legal edges. Restate rejects any handler
 * that tries to set \`status\` to a value that isn't reachable from the
 * current one; the same guard runs client-side, so the UI can't invent
 * illegal actions. You get server-validated state transitions for free
 * — what you'd reach for to model workflows, checkout flows, ticket
 * status, game rounds, etc.
 *
 * The pomodoro workflow (\`src/workflows/pomodoro.workflow.ts\`) calls
 * \`focus.finish()\` via \`entityRef\` after a durable \`ctx.sleep\`,
 * showing how entities compose with workflows: one canonical state
 * machine, any number of server-side callers.
 */
const STATUS = ['idle', 'running', 'done'] as const;

export const focus = defineEntity('focus', {
  state: {
    status: text({ enum: STATUS }),
    topic: text(),
    startedAt: integer(),
    endsAt: integer(),  // 0 = no scheduled end; >0 = pomodoro deadline
  },
  transitions: {
    idle:    ['running'],
    running: ['done', 'idle'],
    done:    ['idle'],
  },
  handlers: {
    start(state, topic: string, now: number, endsAt: number) {
      return { ...state, status: 'running' as const, topic, startedAt: now, endsAt };
    },
    finish(state) {
      return { ...state, status: 'done' as const };
    },
    reset() {
      return { status: 'idle' as const, topic: '', startedAt: 0, endsAt: 0 };
    },
  },
});
`);

    // ── src/heartbeats/pulse.heartbeat.ts
    write(target, 'src/heartbeats/pulse.heartbeat.ts', `\
import { heartbeat } from '@syncengine/server';

/**
 * Heartbeats are the framework's primitive for durable recurring work.
 *
 * This file declares *what* should run and *how often* — the framework
 * handles scheduling, crash recovery, leader election across replicas,
 * and lifecycle state. No entity to hand-roll, no workflow loop to
 * write, no worker to kick off from the client.
 *
 * Key points to read off the config below:
 *
 *   - \`trigger: 'manual'\` means the client calls \`start()\` to launch it.
 *     Use \`'boot'\` (the default) for background jobs that should run
 *     automatically when a workspace comes up.
 *   - \`every: '5s'\` is the interval between ticks. Durations accept
 *     single units ('30s', '5m', '1h', '1d') or cron expressions.
 *   - \`maxRuns: 12\` bounds the run. Omit for unbounded.
 *   - \`scope: 'workspace'\` (default) runs one instance per workspace.
 *     Switch to \`'global'\` for a single cluster-wide loop.
 *
 * Ctrl-C \`syncengine dev\` mid-run and restart — the workflow resumes
 * on schedule. setInterval would have lost those ticks.
 */
export const pulse = heartbeat('pulse', {
  trigger: 'manual',
  scope: 'workspace',
  every: '5s',
  maxRuns: 12,
  run: async (ctx) => {
    // Each tick runs server-side on Restate. \`ctx\` is a full workflow
    // context (ctx.sleep, ctx.run, ctx.date.now, entityRef). The handler
    // can call entities, perform durable external calls, whatever you
    // need. For the demo we just let the framework track run numbers.
    void ctx;
  },
});
`);

    // ── src/topics/presence.topic.ts
    write(target, 'src/topics/presence.topic.ts', `\
import { topic, text } from '@syncengine/core';

/**
 * Topics are the third flavor of state: ephemeral NATS pub/sub.
 *
 *   - table  → durable log, CRDT-merged, fully replicated client-side
 *   - entity → durable server state, serialized handlers
 *   - topic  → transient broadcast, no persistence, no replay
 *
 * Topics shine for presence, cursors, typing indicators, drag positions,
 * and anything else that's fine to lose on refresh. Each connected tab
 * publishes its own payload; peers maintain a live map keyed by the
 * publisher's identity. Throttled by the runtime, TTL-reaped when a
 * peer stops broadcasting.
 */
export const presence = topic('presence', {
  userId: text(),
  color: text(),
});
`);

    // ── src/workflows/pomodoro.workflow.ts
    write(target, 'src/workflows/pomodoro.workflow.ts', `\
import { defineWorkflow, entityRef } from '@syncengine/server';
import { focus } from '../entities/focus.actor';

interface PomodoroInput {
  key: string;         // focus entity key — per-user, so client passes userId
  durationMs: number;  // how long to focus for
}

/**
 * Durable timer — Restate's killer feature.
 *
 * \`ctx.sleep()\` is checkpointed by Restate. You can kill the server
 * mid-sleep, restart it hours later, and the workflow resumes from the
 * same line honoring the original wall-clock deadline. Try it:
 *
 *   1. Click "pomodoro 30s" in the UI to schedule a finish.
 *   2. Ctrl-C \`syncengine dev\` and restart.
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
`);

    // ── src/entities/inbox.actor.ts
    write(target, 'src/entities/inbox.actor.ts', `\
import { defineEntity, integer, emit } from '@syncengine/core';
import { notes } from '../schema';

/**
 * Inbox entity — the server-side ingest point used by the webhook.
 *
 * Webhook handlers run as Restate workflows, which can't write directly
 * to the table pipeline. They \`entityRef\` an entity like this one;
 * the entity's handler serializes the insert and \`emit()\`s a row into
 * the \`notes\` table so every client materializes it through the same
 * CRDT path as a typed note.
 *
 * Why bother with an entity at all? Because the entity runtime owns
 * the bridge from Restate to the sync stream (NATS subject publishing
 * with deterministic nonces). Routing webhook payloads through a
 * named entity keeps the \`emit\` contract obvious and testable.
 */
export const inbox = defineEntity('inbox', {
  state: {
    received: integer(),
  },
  handlers: {
    /** Called by the webhook workflow with a body pre-formatted string. */
    receive(state, body: string, author: string, createdAt: number) {
      return emit(
        { received: state.received + 1 },
        { table: notes, record: { body, author, createdAt } },
      );
    },
  },
});
`);

    // ── src/webhooks/notify.webhook.ts
    write(target, 'src/webhooks/notify.webhook.ts', `\
import { webhook, entityRef } from '@syncengine/server';
import { inbox } from '../entities/inbox.actor';

/**
 * Webhooks are the primitive for inbound HTTP from external services:
 * GitHub/Stripe/Slack, vendor partners, or a curl from your laptop.
 * Each \`webhook()\` compiles to a Restate workflow keyed on the
 * user-supplied \`idempotencyKey\`. That gives you four things for free:
 *
 *   - Signature verification before any body parsing (see \`verify\`).
 *   - Workflow-per-key deduplication — repeat deliveries from the same
 *     event id collapse to one handler execution, even across retries.
 *   - Durable execution — the handler inherits Restate's journal so
 *     crashes mid-flight resume where they left off.
 *   - Fast ack — the HTTP response is a 202 as soon as the workflow is
 *     scheduled; the handler runs async.
 *
 * Try it locally — the dev server exposes this at \`POST /webhooks/notify\`:
 *
 *   echo -n '{"text":"hello from curl","from":"me"}' > /tmp/body.json
 *   SECRET=dev-secret
 *   SIG=$(openssl dgst -sha256 -hmac "$SECRET" -hex < /tmp/body.json | awk '{print $2}')
 *   curl -X POST http://localhost:5173/webhooks/notify \\
 *     -H "content-type: application/json" \\
 *     -H "x-signature: sha256=$SIG" \\
 *     --data-binary @/tmp/body.json
 *
 * A new note appears in the feed instantly — the webhook handler calls
 * the \`inbox\` entity which \`emit()\`s a row into the \`notes\` table,
 * which syncs to every connected client through the same NATS + DBSP
 * pipeline as your own typed notes.
 *
 * Production note: replace \`() => 'dev-secret'\` with a real secret
 * from your env (\`() => process.env.NOTIFY_SECRET!\`) before shipping.
 */
interface NotifyPayload {
  text: string;
  from?: string;
}

export const notify = webhook<'notify', NotifyPayload>('notify', {
  path: '/notify',

  verify: {
    scheme: 'hmac-sha256',
    // Change to \`() => process.env.NOTIFY_SECRET!\` when you wire this to
    // a real sender. For custom schemes (Stripe, Slack timestamped HMAC,
    // Twilio), pass an async function \`(req, rawBody) => ...\` instead.
    secret: () => 'dev-secret',
    header: 'x-signature',
  },

  // Every workspace's data is isolated. Pick something from the payload
  // the sender can stamp; here we just use the configured default so
  // curl against \`/webhooks/notify\` lands in the current workspace.
  resolveWorkspace: () => 'default',

  // Idempotency key = the sender's event id. Repeat deliveries with the
  // same value dedupe. Here we fall back to the request id header so
  // curl-from-the-shell still works while iterating.
  idempotencyKey: (req, payload) => {
    return (
      req.headers.get('x-event-id') ??
      \`notify-\${payload.text}-\${Date.now()}\`
    );
  },

  // Duplicate-response policy. Some senders treat non-2xx as failure
  // and retry forever; flip to '200' for those. Default '409' makes the
  // dedup visible while debugging.
  onDuplicate: '409',

  run: async (ctx, payload) => {
    const author = payload.from ?? 'webhook';
    const body = \`[notify] \${payload.text}\`;

    // Fan out to the inbox entity — one instance per workspace, stable
    // key so the counter accumulates across events. \`entityRef\` lifts
    // the workspace id out of the workflow's own key automatically.
    const inboxRef = entityRef(ctx, inbox, 'main');
    await inboxRef.receive(body, author, Date.now());
  },
});
`);

    // ── Hex: services directory (empty placeholder)
    write(target, 'src/services/.gitkeep', '');

    // ── src/components/WorkspaceSwitcher.tsx
    write(target, 'src/components/WorkspaceSwitcher.tsx', `\
import { useState, useEffect, useMemo, useRef } from 'react';

/**
 * Header pill that lists previously-visited workspaces and lets the
 * user create or switch between them. Each workspace is a fully
 * isolated data scope (separate NATS stream, SQLite replica, entity
 * state); switching navigates via URL param so the target is
 * bookmarkable and the whole React tree + worker remount cleanly.
 */

const WS_STORAGE_KEY = 'syncengine:workspaces';
const WS_DEFAULT = 'default';
const WS_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

function loadKnownWorkspaces(current: string): string[] {
  const base = new Set<string>([WS_DEFAULT, current]);
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(WS_STORAGE_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      for (const v of parsed) {
        if (typeof v === 'string' && WS_NAME_RE.test(v)) base.add(v);
      }
    }
  } catch { /* ignore */ }
  return Array.from(base);
}

function saveKnownWorkspaces(list: readonly string[]): void {
  try {
    localStorage.setItem(WS_STORAGE_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

function currentWorkspaceFromUrl(): string {
  if (typeof window === 'undefined') return WS_DEFAULT;
  return new URL(window.location.href).searchParams.get('workspace') ?? WS_DEFAULT;
}

export function WorkspaceSwitcher() {
  const current = useMemo(currentWorkspaceFromUrl, []);
  const [known, setKnown] = useState<string[]>(() => loadKnownWorkspaces(current));
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [focusIdx, setFocusIdx] = useState(-1);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Persist list whenever we add a new one.
  useEffect(() => { saveKnownWorkspaces(known); }, [known]);

  // Close on outside click + Escape; manage focus return on close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setCreating(false);
    setDraft('');
    setFocusIdx(-1);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function switchTo(name: string) {
    if (name === current) { close(); return; }
    const url = new URL(window.location.href);
    if (name === WS_DEFAULT) url.searchParams.delete('workspace');
    else url.searchParams.set('workspace', name);
    window.location.href = url.toString();
  }

  function submitCreate() {
    const name = draft.trim();
    if (!WS_NAME_RE.test(name)) return;
    if (!known.includes(name)) {
      setKnown((prev) => [...prev, name]);
    }
    switchTo(name);
  }

  function onListKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => Math.min(i + 1, known.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && focusIdx >= 0 && focusIdx < known.length) {
      e.preventDefault();
      switchTo(known[focusIdx]!);
    }
  }

  return (
    <div className="ws-switcher">
      <button
        ref={triggerRef}
        className={'ws-trigger' + (open ? ' is-open' : '')}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="ws-label">workspace</span>
        <span className="ws-name">{current}</span>
        <span className="ws-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="ws-popover"
          role="menu"
          onKeyDown={onListKey}
        >
          <div className="ws-list">
            {known.map((name, i) => (
              <button
                key={name}
                role="menuitem"
                className={
                  'ws-item' +
                  (name === current ? ' is-current' : '') +
                  (i === focusIdx ? ' is-focused' : '')
                }
                onClick={() => switchTo(name)}
                onMouseEnter={() => setFocusIdx(i)}
              >
                <span className="ws-item-name">{name}</span>
                {name === current && <span className="ws-item-check" aria-hidden>●</span>}
              </button>
            ))}
          </div>
          <div className="ws-divider" />
          {!creating ? (
            <button
              className="ws-create"
              onClick={() => {
                setCreating(true);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              <span className="ws-create-icon" aria-hidden>+</span>
              <span>Create workspace</span>
            </button>
          ) : (
            <form
              className="ws-create-form"
              onSubmit={(e) => { e.preventDefault(); submitCreate(); }}
            >
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32))}
                placeholder="name"
                aria-label="New workspace name"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" disabled={!WS_NAME_RE.test(draft.trim())}>go</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
`);

    // ── src/db.ts
    write(target, 'src/db.ts', `\
import { store } from '@syncengine/client';
import { notes, thumbs, stats, recentNotes, allThumbs, notesByAuthor } from './schema';

/**
 * The reactive store. One instance per page load; every hook
 * (useStore / useEntity / useHeartbeat / useTopic) reads from here.
 */
export const db = store({
  tables: [notes, thumbs] as const,
  views: { stats, recentNotes, allThumbs, notesByAuthor },
});

export type DB = typeof db;
`);

    // ── src/lib/authorHue.ts
    write(target, 'src/lib/authorHue.ts', `\
/**
 * Deterministic hue (0-359) derived from any string — used by the UI
 * to color-code author names across the feed, leaderboard, and badges.
 * Same input always produces the same color, so 'alice' looks the
 * same shade of purple everywhere she shows up.
 */
export function authorHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}
`);

    // ── src/components/Presence.tsx
    write(target, 'src/components/Presence.tsx', `\
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
    publish({ userId, color: \`hsl(\${hue}, 70%, 50%)\` });
    const interval = setInterval(() => publish({ userId, color: \`hsl(\${hue}, 70%, 50%)\` }), 5000);
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
`);

    // ── src/components/Focus.tsx
    write(target, 'src/components/Focus.tsx', `\
import { useState, useEffect } from 'react';
import { useStore } from '@syncengine/client';
import { focus } from '../entities/focus.actor';
import { pomodoro } from '../workflows/pomodoro.workflow';
import type { DB } from '../db';

/**
 * Server-side state-machine entity keyed per user so each participant
 * has their own focus state. The +30s button schedules a durable
 * Restate workflow that calls focus.finish() after sleeping —
 * survives server crashes.
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

  async function start(withPomodoroMs?: number) {
    const label = draft.trim();
    if (!label) return;
    const now = Date.now();
    const endsAt = withPomodoroMs ? now + withPomodoroMs : 0;
    actions.start(label, now, endsAt);
    setDraft('');
    if (withPomodoroMs) {
      // Fire-and-forget a durable Restate workflow. Survives server crashes —
      // try killing \`syncengine dev\` mid-timer and watch finish() still fire.
      await s.runWorkflow(pomodoro, { key: userId, durationMs: withPomodoroMs });
    }
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
`);

    // ── src/components/Heartbeat.tsx
    write(target, 'src/components/Heartbeat.tsx', `\
import { useState, useEffect } from 'react';
import { useHeartbeat } from '@syncengine/client';
import { pulse } from '../heartbeats/pulse.heartbeat';

/**
 * \`useHeartbeat(pulse)\` subscribes to the framework-owned status
 * entity and returns the live state (status, runNumber, lastRunAt)
 * alongside lifecycle methods (start/stop/reset). No entity, workflow,
 * or client kick-off code to hand-roll.
 *
 * Crash-safe: kill \`syncengine dev\` mid-run, restart it, and ticks
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
`);

    // ── src/components/Leaderboard.tsx
    write(target, 'src/components/Leaderboard.tsx', `\
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
              <span className="bar-label" style={{ color: \`hsl(\${authorHue(author)}, 70%, 65%)\` }}>
                {author}
              </span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: pct + '%', background: \`hsl(\${authorHue(author)}, 60%, 45%)\` }} />
              </span>
              <span className="bar-count">{Number(r.count)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
`);

    // ── src/components/NoteFeed.tsx
    write(target, 'src/components/NoteFeed.tsx', `\
import { authorHue } from '../lib/authorHue';

/**
 * The main note feed + thumbs-up control. One row per note; the
 * thumbs-up button toggles a per-user row in the \`thumbs\` table,
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
            <span className="note-author" style={{ color: \`hsl(\${h}, 70%, 65%)\` }}>
              {String(n.author)}
            </span>
            <span className="note-body">{String(n.body)}</span>
            <button
              className={\`thumb \${thumbed ? 'thumbed' : ''}\`}
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
`);

    // ── src/App.tsx
    write(target, 'src/App.tsx', `\
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
          <span className="badge" style={{ background: \`hsl(\${hue}, 70%, 40%)\` }}>
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

.badges { display: flex; gap: 0.4rem; align-items: center; }

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

/* ── Workspace switcher ────────────────────────────────────── */

.ws-switcher {
  position: relative;
  display: inline-flex;
}

.ws-trigger {
  appearance: none;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 9px 3px 9px;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--fg);
  font-size: 0.7rem;
  font-family: var(--mono);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, transform 0.06s;
  user-select: none;
}

.ws-trigger:hover {
  border-color: #3a3a42;
  background: #1c1c21;
}

.ws-trigger:active {
  transform: scale(0.98);
}

.ws-trigger:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
}

.ws-trigger.is-open {
  border-color: var(--accent);
  background: #1c1c21;
}

.ws-label {
  color: var(--muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-size: 0.6rem;
}

.ws-name {
  color: var(--fg);
  max-width: 9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-caret {
  color: var(--muted);
  font-size: 0.55rem;
  line-height: 1;
  margin-left: 0.05rem;
  transition: transform 0.15s ease;
}

.ws-trigger.is-open .ws-caret {
  transform: rotate(180deg);
}

.ws-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 11rem;
  background: #101014;
  border: 1px solid #26262c;
  border-radius: 10px;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.03) inset,
    0 12px 32px rgba(0, 0, 0, 0.55),
    0 2px 6px rgba(0, 0, 0, 0.35);
  padding: 4px;
  z-index: 20;
  transform-origin: top right;
  animation: ws-pop-in 140ms cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes ws-pop-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .ws-popover { animation: none; }
  .ws-caret { transition: none; }
}

.ws-list {
  display: flex;
  flex-direction: column;
  max-height: 14rem;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #2a2a31 transparent;
}

.ws-list::-webkit-scrollbar { width: 6px; }
.ws-list::-webkit-scrollbar-thumb { background: #2a2a31; border-radius: 3px; }

.ws-item {
  appearance: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  background: transparent;
  border: 0;
  color: var(--fg);
  padding: 0.4rem 0.55rem;
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 0.78rem;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
  gap: 0.5rem;
}

.ws-item.is-focused,
.ws-item:hover {
  background: #1c1c21;
}

.ws-item.is-current {
  background: rgba(99, 102, 241, 0.12);
}

.ws-item.is-current.is-focused,
.ws-item.is-current:hover {
  background: rgba(99, 102, 241, 0.18);
}

.ws-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-item-check {
  color: var(--accent);
  font-size: 0.45rem;
  flex-shrink: 0;
  line-height: 1;
}

.ws-divider {
  height: 1px;
  background: #26262c;
  margin: 4px 2px;
}

.ws-create {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  background: transparent;
  border: 0;
  color: var(--muted);
  padding: 0.4rem 0.55rem;
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 0.75rem;
  cursor: pointer;
  text-align: left;
  transition: color 0.12s, background 0.12s;
}

.ws-create:hover {
  color: var(--fg);
  background: #1c1c21;
}

.ws-create-icon {
  width: 18px;
  height: 18px;
  display: inline-grid;
  place-items: center;
  border: 1px dashed #2f2f36;
  border-radius: 5px;
  font-size: 0.75rem;
  color: var(--muted);
  transition: border-color 0.12s, color 0.12s;
  line-height: 1;
}

.ws-create:hover .ws-create-icon {
  border-color: var(--accent);
  color: var(--accent);
}

.ws-create-form {
  display: flex;
  gap: 4px;
  padding: 3px;
  align-items: stretch;
}

.ws-create-form input {
  flex: 1;
  min-width: 0;
  background: var(--bg-card);
  border: 1px solid #26262c;
  border-radius: 6px;
  padding: 0.35rem 0.55rem;
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--fg);
  outline: none;
  transition: border-color 0.12s;
}

.ws-create-form input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.18);
}

.ws-create-form input::placeholder {
  color: var(--muted);
}

.ws-create-form button {
  background: var(--accent);
  border: 0;
  border-radius: 6px;
  color: white;
  font-family: var(--mono);
  font-size: 0.7rem;
  padding: 0 0.7rem;
  cursor: pointer;
  transition: opacity 0.1s, transform 0.06s;
}

.ws-create-form button:hover:not(:disabled) { opacity: 0.92; }
.ws-create-form button:active:not(:disabled) { transform: scale(0.96); }

.ws-create-form button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.input-row {
  margin-top: 1.5rem;
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

.thumb {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--fg);
  padding: 2px 8px;
  font-size: 0.75rem;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  transition: transform 0.06s, border-color 0.15s, background 0.15s;
}

.thumb:hover { border-color: var(--accent); }
.thumb:active { transform: scale(0.9); }

.thumb.thumbed {
  background: rgba(99, 102, 241, 0.15);
  border-color: var(--accent);
}

.thumb-count {
  font-family: var(--mono);
  font-size: 0.7rem;
  color: var(--muted);
}

.thumb.thumbed .thumb-count { color: var(--fg); }

.muted { color: var(--muted); font-size: 0.85rem; }

.focus {
  margin-top: 0.5rem;
  padding: 0.55rem 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.85rem;
}

.focus-label {
  font-family: var(--mono);
  font-size: 0.65rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  flex-shrink: 0;
}

.focus-topic {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.focus input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--fg);
  font-size: 0.85rem;
}

.focus input::placeholder {
  color: var(--muted);
}

.focus button {
  background: var(--accent);
  border: none;
  border-radius: 4px;
  color: white;
  padding: 0.3rem 0.7rem;
  font-size: 0.72rem;
  font-family: var(--mono);
  cursor: pointer;
  transition: opacity 0.15s, transform 0.06s;
}

.focus button:hover:not(:disabled) { opacity: 0.9; }
.focus button:active:not(:disabled) { transform: scale(0.96); }

.focus button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.focus button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
}

.focus button.pomodoro {
  background: #dc2626;
}

.focus-countdown {
  font-family: var(--mono);
  font-size: 0.8rem;
  color: #f87171;
  padding: 2px 6px;
  background: rgba(220, 38, 38, 0.15);
  border-radius: 4px;
  flex-shrink: 0;
}

.leaderboard {
  margin-top: 1.5rem;
  padding: 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.leaderboard h2 {
  font-family: var(--mono);
  font-size: 0.65rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 500;
  margin-bottom: 0.5rem;
}

.leaderboard ul {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.leaderboard li {
  display: grid;
  grid-template-columns: 5rem 1fr 2rem;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
}

.leaderboard .bar-label {
  font-family: var(--mono);
  font-size: 0.72rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.leaderboard .bar-track {
  height: 6px;
  background: #232326;
  border-radius: 3px;
  overflow: hidden;
}

.leaderboard .bar-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease;
}

.leaderboard .bar-count {
  font-family: var(--mono);
  font-size: 0.72rem;
  color: var(--muted);
  text-align: right;
}

.heartbeat-wrap {
  margin-top: 0.75rem;
}

.heartbeat {
  padding: 0.5rem 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.85rem;
}

.heartbeat-progress {
  font-family: var(--mono);
  font-size: 0.75rem;
  flex-shrink: 0;
}

.heartbeat-progress.done { color: #22c55e; }

.heartbeat-bar {
  flex: 1;
  min-width: 3rem;
  height: 6px;
  background: #232326;
  border-radius: 3px;
  overflow: hidden;
}

.heartbeat-bar-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #22c55e, #4ade80);
  transition: width 0.3s ease;
}

.heartbeat-hint {
  font-size: 0.7rem;
  margin-top: 0.35rem;
  padding: 0 0.75rem;
}

.pulse-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6);
  animation: pulse 1.6s infinite;
}

@keyframes pulse {
  0%   { box-shadow: 0 0 0 0   rgba(34, 197, 94, 0.5); }
  70%  { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0);   }
  100% { box-shadow: 0 0 0 0   rgba(34, 197, 94, 0);   }
}

.heartbeat-since {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 0.7rem;
}

.heartbeat button {
  background: var(--accent);
  border: none;
  border-radius: 4px;
  color: white;
  padding: 0.3rem 0.65rem;
  font-size: 0.72rem;
  font-family: var(--mono);
  cursor: pointer;
  transition: opacity 0.15s, transform 0.06s;
}

.heartbeat button:hover { opacity: 0.9; }
.heartbeat button:active { transform: scale(0.96); }

.heartbeat button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
}

.presence {
  margin-top: 0.75rem;
  padding: 0.45rem 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  font-size: 0.8rem;
}

.peer-dot {
  font-family: var(--mono);
  font-size: 0.65rem;
  padding: 2px 8px;
  border-radius: 10px;
  color: white;
}

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
