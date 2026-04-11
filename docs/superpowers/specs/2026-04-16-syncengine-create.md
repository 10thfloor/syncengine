# syncengine init — Zero to Wow

**Date:** 2026-04-16
**Status:** Draft
**Scope:** `@syncengine/cli` (init.ts rewrite)

## Summary

Rewrite `syncengine init` to scaffold a "shared notepad" demo that shows real-time sync in 10 seconds — open two browser tabs, type in one, see it in the other. The command auto-detects the package manager, installs dependencies, and prints a ready-to-run banner. No prompts, no manual steps between scaffold and `syncengine dev`.

## Goals

- Zero to running app in one command + `syncengine dev`
- The wow moment: two tabs, real-time sync, no server code visible
- Auto-detect package manager (pnpm/npm/yarn), default to pnpm
- Polished CLI output (box header, spinners, checkmarks)

## Non-Goals

- Template selection (single template for now)
- Interactive prompts (project name from CLI argument)
- Separate `create-syncengine` package (stays in CLI)
- Published npm versions (use `"latest"` placeholder with workspace override comment)

---

## The Wow Template: Shared Notepad

Three files the developer sees as "the app":

### `src/schema.ts`

```typescript
import { table, id, text, integer, view, count } from '@syncengine/core';

export const notes = table('notes', {
  id: id(),
  body: text(),
  author: text(),
  createdAt: integer(),
});

// Global aggregate — incremental count via DBSP (not .length)
export const stats = view(notes).aggregate([], {
  totalNotes: count(),
});

// Recent notes — topN shows incremental eviction as new notes push old ones out
export const recentNotes = view(notes)
  .topN(notes.createdAt, 20, 'desc');
```

### `src/App.tsx`

- Input field at top — type a note, press Enter
- Live feed from `recentNotes` view (newest first, max 20, styled cards)
- Per-author color coding: hash the author name to an HSL hue so each user's notes are visually distinct across tabs
- Stats badge: "N notes" updating via DBSP incremental count
- Author derived from `?user=` query param (default "anon")
- Minimal dark theme, clean typography
- Footer: "Open another tab with `?user=bob` to see real-time sync"
- Store subscribes to both views: `db.use({ stats, recentNotes })`

### `syncengine.config.ts`

```typescript
import { defineConfig } from '@syncengine/core';

export default defineConfig({
  workspaces: {
    resolve: () => 'default',
  },
});
```

### Supporting files (generated, not the focus)

- `main.tsx` — React entry with StoreProvider
- `index.html` — minimal shell
- `vite.config.ts` — syncengine + React + WASM plugins
- `tsconfig.json` — standard React/TypeScript config
- `index.css` — dark theme baseline with author color support
- `.gitignore` — node_modules, .syncengine, dist, *.local
- `package.json` — deps use `"latest"` as version placeholder. In monorepo development, the CLI detects the workspace and overrides with `workspace:*` at scaffold time.

---

## CLI Experience

### Command

```
syncengine init my-app
```

### Output

```
  ┌─────────────────────────────────────────┐
  │                                         │
  │   syncengine                            │
  │                                         │
  │   Creating: my-app                      │
  │                                         │
  └─────────────────────────────────────────┘

  ✓ Scaffolded project files
  ✓ Detected pnpm
  ◐ Installing dependencies...
  ✓ Installed dependencies

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Your syncengine app is ready.

    cd my-app
    syncengine dev

  Then open two browser tabs to see real-time sync.

```

### Package Manager Detection

Priority order:
1. `npm_config_user_agent` env var (set by npm/pnpm/yarn when running via npx/pnpx)
2. Parent directory lockfile (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm)
3. Default: pnpm

### Error Handling

- Directory not empty (non-dotfiles present) → throw with clear message
- Install fails → scaffold is preserved, print "Install failed. Run `<pm> install` manually."
- No argument → use current directory (`.`)

### CLI Formatting

- ANSI box for header (using simple `─│┌┐└┘` characters)
- `✓` green checkmark for completed steps
- Animated spinner (`◐◓◑◒` cycle) during install
- `━` line separator before final banner
- All output indented 2 spaces for visual hierarchy
- Colors: green for success, yellow for spinner, white for text, dim for paths

---

## Implementation Details

### File: `packages/cli/src/init.ts`

Complete rewrite. The file becomes:

1. **`initCommand(args)`** — main entry, validates target dir, orchestrates scaffold + install
2. **`scaffoldProject(target, name)`** — writes all template files
3. **`detectPackageManager(target)`** — returns `'pnpm' | 'npm' | 'yarn'`
4. **`installDeps(target, pm)`** — spawns install process with spinner
5. **`printBanner(name, pm)`** — final success output

### Spinner

A simple interval-based character cycle using `process.stderr.write('\r  ◐ Installing...')`. No dependency on `ora` or similar — keep the CLI zero-dep for fast startup.

### Template: `index.css`

Dark theme matching the test app's design tokens:
```css
:root {
  color-scheme: dark;
  --bg: #09090b;
  --bg-card: #18181b;
  --border: #27272a;
  --fg: #fafafa;
  --muted: #71717a;
  --accent: #6366f1;
  --radius: 8px;
  --mono: 'SF Mono', 'Fira Code', monospace;
}
```

---

## File Inventory

| File | Change |
|------|--------|
| `packages/cli/src/init.ts` | Complete rewrite — new template, auto-install, CLI formatting |
