# Contributing

Thanks for your interest. The framework is pre-1.0 and APIs may still
move — but feedback, bug reports, and PRs are welcome.

## Getting set up

**Requirements:** Node 22+, pnpm 9+, Rust toolchain (for the DBSP WASM
build — only needed if you rebuild `packages/dbsp-engine`).

```bash
git clone <repo-url>
cd <repo-dir>
pnpm install
pnpm -r test
```

The first `pnpm install` also builds the DBSP WASM artifact via
`scripts/sync-wasm.mjs`. Subsequent installs reuse it.

## Dogfooding the CLI

The fastest way to exercise your changes end-to-end is to scaffold a
throwaway app inside the monorepo:

```bash
pnpm --filter @syncengine/cli exec node ./bin/syncengine.mjs init ../../apps/my-scratch
pnpm install                       # picks up the new workspace member
cd apps/my-scratch && pnpm dev
```

Scaffolded apps under `apps/` are workspace members that use
`workspace:*` deps, so they re-resolve against your local edits
immediately — no publish dance.

## Project layout

```
packages/
  core/           primitives, types, validation
  server/         runtime, workflow DSL, test harness
  client/         React hooks, store, optimistic handlers
  cli/            `syncengine init | dev | build | start | add`
  vite-plugin/    dev server integration
  gateway-core/   bus dispatcher, delivery semantics
  serve/          compiled edge HTTP server
  dbsp-engine/    incremental view WASM (Rust)
  observe/        OpenTelemetry SDK wrapper
  ...
apps/
  test/           kitchen-sink demo — every primitive, end-to-end
  notepad/        collaborative notes (presence, CRDT deltas)
docs/
  guides/         one guide per primitive
  superpowers/    specs and plans (internal design history)
```

## Running tests

```bash
pnpm -r test              # every package
pnpm -F @syncengine/core test   # a single package
pnpm -F @syncengine/server test:watch
```

Most of the framework has in-memory harnesses — `vitest` runs without
Docker, without a live NATS, without Restate. If you're touching the
bus or entity runtime, use `createBusTestHarness` and `applyHandler`
rather than spinning up infrastructure.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add op() helper for value objects
fix(cli): pin vite to 6.4.2 to avoid module-runner race
docs(readme): rewrite as tutorial hub
chore: remove docker smoke path
refactor(server): rename resolveWorkspaceForMetrics → ...
```

The first parenthetical scope is typically the package name
(`core`, `cli`, `server`, `vite-plugin`, `readme`, ...). Keep the
subject under 70 characters; put detail in the body.

## Pull requests

1. Open an issue first for anything larger than a bug fix or a small
   refactor — worth agreeing on scope before you spend time.
2. Work on a feature branch off `main`.
3. Keep the PR focused. One commit or a small stack is ideal; if
   you're mixing refactor + feature, split them.
4. Make sure `pnpm -r test` is green and `pnpm -r typecheck` passes.
5. Update `CHANGELOG.md` under `[Unreleased]` if the change is
   user-visible (new primitive, new flag, breaking API, bug fix in a
   published behavior).
6. Reference the issue in the PR body.

## Reporting bugs

Include:
- `syncengine --version` (once that lands) or the commit SHA you're on
- Node version (`node --version`)
- Minimal reproduction — ideally a scaffolded app diff
- What you expected vs. what happened
- Relevant log output with `pnpm dev --verbose` (restores raw NATS +
  Restate logs)

## Code conventions

- TypeScript everywhere. No `any` without a comment explaining why.
- Pure functions by default. Side effects happen in services and
  workflows, not handlers.
- Small, focused modules. One exported thing per file when possible.
- Comments explain *why*, not *what*. If a line of code is non-obvious,
  add a one-liner above it with the intent or the constraint.
- No new runtime dependencies without discussion — each one is a
  surface we have to support.

## Internal design docs

`docs/superpowers/` holds the design specs and implementation plans
that track what was built and why. New subsystems get a `specs/*.md`
(what we're building, acceptance criteria) and a `plans/*.md` (how
we're building it, task breakdown). Feel free to read them for
context, but don't feel obligated to write one for small changes.

## Questions

Open a GitHub issue with the `question` label, or start a discussion
thread.
