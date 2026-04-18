# CLI Guide — `syncengine` commands

> One command surface for scaffolding, running, building, and
> operating syncengine apps. Launched via `pnpm syncengine <cmd>`
> (or `npx syncengine <cmd>`). Every subcommand respects the
> `syncengine.config.ts` at the current working directory.

## Quick reference

```
syncengine init           Scaffold a new app
syncengine add <kind>     Add a new primitive (bus | service | ...)
syncengine dev            Run dev server (hot-reload, in-memory NATS + Restate)
syncengine start          Run production build (expects NATS + Restate running)
syncengine build          Compile to dist/ (client bundle + server entry)
syncengine serve          Run Bun edge + Node handlers (scale-out deploy)
syncengine down           Stop anything syncengine launched
syncengine status         Show running processes
syncengine state reset    Wipe workspace state (admin)
syncengine state ...      Other state admin commands
syncengine client         Client-side utilities
syncengine workspace      Workspace admin
syncengine entity         Entity admin (inspect, rpc)
```

## `syncengine init`

Scaffolds a new project. Interactive — asks for app name, picks starter, runs `pnpm install`:

```bash
syncengine init my-app
cd my-app
syncengine dev
```

What it lays down:
- `syncengine.config.ts` with a default workspace resolver
- `src/schema.ts` with a sample table
- `src/entities/` with one example entity
- `src/topics/` scaffold directory
- `src/events/` scaffold directory (for `.bus.ts` declarations)
- `vite.config.ts` pre-wired with `@syncengine/vite-plugin`
- A React `App.tsx` demoing `useTable`, `useEntity`, `useTopic`

## `syncengine add <kind> <name>`

Scaffolds a single primitive with the right file location + naming convention:

```bash
syncengine add bus orderEvents
# → src/events/orderEvents.bus.ts

syncengine add service payments
# → src/services/payments.ts
```

Supported kinds today: `bus`, `service`. Entity / workflow / webhook / heartbeat / table are defined inline (no scaffold yet — just copy a file from `apps/kitchen-sink/src/`).

## `syncengine dev`

Runs the whole stack in development mode:

- Vite dev server at `http://localhost:5173` (HMR, sourcemaps)
- Local NATS at `ws://localhost:9222` (managed binary from `@syncengine/nats-bin`)
- Local Restate at `http://localhost:8080` (managed binary from `@syncengine/restate-bin`)
- Your workspace service (entities, workflows, heartbeats, webhooks, bus subscribers) at `:9080` via `tsx watch`
- `syncengine.workspaces` registry topic live for provision broadcasts

Hot-reload on any `.ts` / `.tsx` file. Restate re-registers the workspace service on edits; workspace state persists across restarts. `Ctrl-C` tears everything down cleanly.

Environment overrides:
```bash
PORT=4000 syncengine dev                     # change HTTP port
NATS_PORT=19222 syncengine dev               # change NATS port (useful if port's busy)
SYNCENGINE_NO_BUS_SIGNALS=1 syncengine dev   # skip SIGTERM drain handler
```

## `syncengine build`

Compiles for production:

```
dist/
├── index.html
├── assets/*.{js,css,wasm}      ← client bundle via Vite
├── server/
│   ├── index.mjs               ← generated server entry (startRestateEndpoint + bootBusRuntime)
│   └── config.mjs              ← your syncengine.config.ts compiled to CJS
└── .syncengine/                ← vite-plugin manifest + actor discovery
```

The generated `server/index.mjs` is self-contained — imports `@syncengine/server` runtime, your actors, buses, and services, and bootstraps them at startup. Deploys as a single Node process.

## `syncengine start`

Runs `dist/server/index.mjs` with the HTTP server attached. Expects NATS + Restate reachable via:

```bash
SYNCENGINE_NATS_URL=nats://prod-nats:4222 \
SYNCENGINE_RESTATE_URL=http://prod-restate:8080 \
syncengine start
```

One process handles HTTP, runs the workspace service, and runs the bus runtime. For scale-out (edge + handlers split), use `syncengine serve` instead.

## `syncengine serve`

Scale-out production mode. Splits the edge tier (HTTP) from the handlers tier (Restate workspace service + bus subscribers):

```bash
# Edge tier — single Bun binary, handles HTTP + WebSockets
syncengine serve edge

# Handlers tier — Node process, runs the workspace service + bus runtime
SYNCENGINE_HANDLERS_ONLY=1 syncengine serve handlers
```

`syncengine serve edge` is a compiled Bun binary — fast cold start, single-file distribution. It proxies RPC + WebSocket traffic to the handlers tier over shared NATS + Restate.

See `docs/guides/deployment.md` for full topology.

## `syncengine state`

Admin commands for workspace state:

```
syncengine state reset --workspace <ws>       Wipe a workspace's Restate + JetStream state
syncengine state inspect --workspace <ws>     Show workspace provision status
```

Destructive — prompts for confirmation unless `--yes`.

## `syncengine workspace`

Workspace admin:

```
syncengine workspace list                     List provisioned workspaces
syncengine workspace provision <ws>           Manually provision a workspace
syncengine workspace authority <ws> <channel> Get current authority seq
```

## `syncengine entity`

Inspect and call entities from the CLI:

```
syncengine entity inspect <entityName> <key>             Show current state
syncengine entity rpc <entityName> <key> <handler> [args] Invoke a handler
```

Useful for operational debugging without writing glue code.

## `syncengine down`

Stops anything syncengine launched (dev server, NATS, Restate binaries). Safe to run when nothing is running — exits zero.

## `syncengine status`

Dumps running-process info — which ports are bound, PID of NATS + Restate, last boot time. Quick "what's up" check.

## Environment variables (full list)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `5173` (dev), `3000` (prod) | HTTP port |
| `SYNCENGINE_NATS_URL` | `ws://localhost:9222` (dev) | NATS WS URL (client); `nats://` for server |
| `SYNCENGINE_RESTATE_URL` | `http://localhost:8080` | Restate ingress URL |
| `SYNCENGINE_APP_DIR` | auto-detected | App root for server bootstrap |
| `SYNCENGINE_HANDLERS_ONLY` | `0` | Scale-out: handlers tier only (no HTTP) |
| `SYNCENGINE_NO_BUS_SIGNALS` | `0` | Skip bus SIGTERM drain (when host owns shutdown) |
| `NATS_PORT` | `9222` (WS), `4222` (TCP) | Local NATS ports |

## Footguns

- **Workspaces persist across dev restarts.** If you change your entity schema, `syncengine state reset` is usually what you want — otherwise old state will fail new validation.
- **Restate keeps its service registry across restarts.** If you rename a handler, restart the dev server; if Restate still serves the old registry, `syncengine state reset` clears it. Alternatively, force re-registration via `curl -X POST http://localhost:9070/deployments -d '{"uri":"http://127.0.0.1:9080","force":true}'`.
- **Dev runs all binaries locally.** On CI you probably want `docker compose` + the smoke script instead — `syncengine dev` expects writable local state dirs.
- **`syncengine build` output is portable.** `dist/` has zero dev-only deps; ship it as-is.

## Links

- CLI source: `packages/cli/src/`
- Dev orchestrator: `packages/cli/src/dev.ts`, `runner.ts`
- Build generator: `packages/cli/src/build.ts`
- Serve (scale-out): `packages/cli/src/serve.ts`
