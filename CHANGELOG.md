# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aspires to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once 1.0 ships. Until then, breaking changes can land on minor versions
and will be called out explicitly below.

## [Unreleased]

## [0.1.2] — 2026-04-23

### Fixed

- **Vite `fs.allow` auto-configured.** `@syncengine/vite-plugin` now
  adds `~/.syncengine/source/` to `server.fs.allow`, so dev-mode
  requests for framework worker files (e.g. `data-worker.js`) no
  longer 403 when Vite dereferences the project-local `.syncengine/source`
  symlink into the cache's real path.
- **v0.1.1 release tarball never materialized** — the CI workflow tried
  to copy a non-existent `packages/dbsp-engine/package.json`. v0.1.2
  ships the fix alongside the tarball-self-containment work that was
  intended for v0.1.1.

## [0.1.1] — 2026-04-23

### Fixed

- **Source tarball is now self-contained.** v0.1.0's tarball shipped
  framework source only; when a user project imported through the
  symlinked `node_modules/@syncengine/server`, Node followed the link
  to the cache's real path and failed to resolve transitive deps like
  `@restatedev/restate-sdk`. The release workflow now strips devDeps,
  generates a cache-scoped `pnpm-lock.yaml`, and ships it inside the
  tarball; the CLI runs `pnpm install --frozen-lockfile` inside the
  cache on first extract so transitive deps resolve cleanly.

### Added (experimental)

- **`edge(name, from, to, { cardinality?, props? })` — @experimental.**
  Thin typed sugar over a synthesized table with a `(from, to)` shape.
  Edges ARE tables; writes go through the normal three-verb CRUD on
  `edge.$table` or `s.tables.<edgeName>.*`. Reads compose
  Gremlin-style: `edge.out(id)` / `edge.in(id)` start a traversal;
  `.has(col, 'eq', val)` filters on props; `.out(nextEdge)` /
  `.in(nextEdge)` hop; `.values()` terminates to a `ViewBuilder` of
  target records. User-defined props are hoisted as column refs
  (`tagged.weight`); the synthetic `from`/`to` stay internal. No
  runtime cardinality enforcement (`$cardinality` is a type-level
  hint — hard cardinality invariants belong on entities). No
  fixpoint / transitive closure; chain explicit hops for n-hop
  traversals. API will iterate based on real usage — no guide yet.

### Added

- **`update(table, id, patch)` — the third table verb.** Completes the
  CRDT-native CRUD triplet (`insert`, `update`, `remove`), available
  both as an entity `emit` effect and as `s.tables.X.update(id, patch)`
  on the client. Each patched column respects its configured `merge`
  strategy — the column schema *is* the CRDT op for that path. Patches
  touching the primary key or `merge:false` columns are rejected at
  handler time; missing rows make the update a silent no-op. Wire carries
  only the patch; each replica performs read-modify-write against its
  local row, and DBSP's `TableMergeState` resolves per-column merge on
  the `+merged` delta at the view layer. New `UPDATE` NATS envelope
  parallel to `INSERT`/`DELETE`; entity emits publish in the wire order
  `INSERTs → UPDATEs → DELETEs`.

- **`remove(table, id)` entity effect.** Entity handlers can now delete
  table rows inside `emit({ state, effects: [...] })`, symmetric to
  `insert()`. Removes flow through the same NATS subject and data-worker
  consumer as client-initiated `s.tables.X.remove(id)`, so tombstone /
  LWW behaviour is identical. Inserts publish before removes within a
  single `emit()` call.

## [0.1.0] — 2026-04-23

Initial public release.

### Core primitives

- **`table()`** — typed schema, CRDT-synced rows, no ORM or migrations
- **`view()`** — incremental materialized queries powered by DBSP; writes produce deltas, not re-scans
- **`entity()`** — pure-function handlers, single-writer per key, durable via Restate virtual objects
- **`emit()`** — atomic state + effect commits (state write + table insert + event publish land together)
- **`bus()`** — typed event streams with fan-out, DLQ, and per-subscriber retry/ordering/concurrency
- **`defineWorkflow()`** — durable orchestration, `ctx.sleep(days(3))` survives crashes and deploys
- **`service()`** — hex-architecture ports; mock in tests, real adapter in prod

### Peripherals

- **`webhook()`** — inbound HTTP with signature verification + idempotency-keyed durable execution
- **`heartbeat()`** — recurring jobs with crash-safe resume across deploys
- **`topic()`** — ephemeral pub/sub for cursors, presence, typing indicators
- **`config({ workspaces })`** — multi-tenant scoping at the wire (not a query-time filter)

### Client

- **`useStore`**, **`useEntity`**, **`useView`**, **`useTopic`**, **`useHeartbeat`** — React hooks with optimistic updates; handlers run identically on both sides of the wire

### Tooling

- **`syncengine` CLI** — init, dev, build, start, serve, add. Shipped as a standalone Bun-compiled binary; install via `curl | bash`, no Node required to run the CLI
- **`@syncengine/vite-plugin`** — dev server integration, actor/workflow discovery by file suffix
- **In-memory test harness** — `createBusTestHarness` exercises entity + bus + workflow paths in `vitest` with no Docker

### Under the hood

- Restate 1.6 for durable execution
- NATS JetStream 2.12 for transport
- DBSP (Rust → WASM) for incremental views
- Bun for the edge server binary

### Distribution

- CLI binary: GitHub Releases (curl-installed to `~/.syncengine/bin/`)
- Framework source: attached to each Release as `syncengine-source-<version>.tar.gz`; downloaded on demand and linked into projects by the CLI. No npm, no JSR.

Getting started: `curl -fsSL https://raw.githubusercontent.com/10thfloor/syncengine/main/install/install.sh | bash && syncengine init my-platform`.
