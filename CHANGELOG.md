# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aspires to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once 1.0 ships. Until then, breaking changes can land on minor versions
and will be called out explicitly below.

## [Unreleased]

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
- Libraries: [JSR](https://jsr.io/@syncengine) as `@syncengine/core`, `@syncengine/client`, `@syncengine/server`, `@syncengine/vite-plugin`

Getting started: `curl -fsSL https://raw.githubusercontent.com/10thfloor/syncengine/main/install/install.sh | bash && syncengine init my-app`.
