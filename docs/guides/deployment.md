# Deployment Guide

> Three supported shapes: dev (`syncengine dev`), single-process
> production (`syncengine start`), and scale-out
> (`syncengine serve` edge + handlers). Pick the smallest that
> meets your scale — dev for local, single-process for most apps,
> scale-out when HTTP traffic dominates compute.

## Shape 1 — `syncengine dev` (local development)

Everything in one terminal. Vite + NATS + Restate + workspace service + bus runtime all owned by the CLI.

```bash
pnpm syncengine dev
# App           → http://localhost:5173
# NATS WS       → ws://localhost:9222
# NATS monitor  → http://localhost:8222
# Restate       → http://localhost:8080
# Restate admin → http://localhost:9070
# Workspace svc → http://localhost:9080
```

Hot-reload, persistent state, one-process debugging. Don't use in production — binds to `localhost`, runs NATS + Restate from binary bundles in `@syncengine/nats-bin` and `@syncengine/restate-bin`.

## Shape 2 — `syncengine start` (single-process production)

One Node process runs HTTP + the workspace service + the bus runtime. External NATS + Restate deploy alongside it (same host or separate).

```bash
syncengine build
SYNCENGINE_NATS_URL=nats://nats:4222 \
SYNCENGINE_RESTATE_URL=http://restate:8080 \
PORT=3000 \
syncengine start
```

Generated `dist/server/index.mjs` is portable — `node dist/server/index.mjs` works anywhere with Node 22+.

### Docker-compose example

```yaml
# docker-compose.yml
services:
  nats:
    image: nats:2.12-alpine
    command: ["-c", "/etc/nats/nats.conf"]
    volumes:
      - ./docker/nats.conf:/etc/nats/nats.conf:ro
    ports: ["4222:4222", "9222:9222", "8222:8222"]

  restate:
    image: docker.restate.dev/restatedev/restate:1.6
    environment:
      RESTATE_AUTO_PROVISION: "true"
    ports: ["8080:8080", "9070:9070"]

  app:
    build: .
    environment:
      SYNCENGINE_NATS_URL: nats://nats:4222
      SYNCENGINE_RESTATE_URL: http://restate:8080
      PORT: "3000"
    depends_on: { nats: { condition: service_healthy }, restate: { condition: service_healthy } }
    ports: ["3000:3000"]
```

`Dockerfile` for the app:
```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app
COPY --chown=node:node dist/ ./dist/
USER node
CMD ["node", "dist/server/index.mjs"]
```

That's the full production deploy for most apps. NATS + Restate are stateful services with their own persistence — back them up like any database.

## Shape 3 — `syncengine serve` (scale-out)

Split HTTP from backend. Useful when:

- HTTP traffic is much higher than entity/workflow compute
- You want an edge tier near users (CDN PoPs, Cloudflare-style)
- You want independent autoscaling

**Edge tier** — Bun binary, HTTP + WebSocket proxy:
```bash
syncengine serve edge
# Binds :3000, serves static assets, proxies RPC + WebSocket to handlers
```

**Handlers tier** — Node process, runs the workspace service + bus runtime:
```bash
SYNCENGINE_HANDLERS_ONLY=1 syncengine serve handlers
# Binds :9080, no HTTP — just Restate workspace service + bus dispatchers
```

Both connect to shared NATS + Restate. Edge scales horizontally by traffic; handlers scale by workspace count / bus throughput.

### Topology

```
 ┌──────────┐  ws/http  ┌──────────┐   rpc   ┌───────────┐
 │ Browser  │──────────▶│ Edge     │────────▶│ Handlers  │
 └──────────┘           │ (Bun)    │         │ (Node)    │
                        └────┬─────┘         └──────┬────┘
                             │                      │
                             ▼                      ▼
                          ┌──────┐              ┌─────────┐
                          │ NATS │◀─────────────│ Restate │
                          └──────┘              └─────────┘
```

Edge is stateless — kill a pod, spin up another. Handlers hold bus dispatcher state (consumer cursors), so handler restarts are coordinated with NATS consumer durability (`bus:<bus>:<subscriber>` durable names persist).

See `docker-compose.serve.yml` in the repo root for the full scale-out stack.

## Shape 4 — Future `syncengine launch` (Galaxy-style PaaS)

Planned. One command to ship to syncengine's own hosted platform. Not shipped yet; the CLI slot is reserved.

## Environment variables

| Var | When | Purpose |
|---|---|---|
| `PORT` | all | HTTP port |
| `SYNCENGINE_NATS_URL` | prod | `nats://` for server, `ws://` for edge tier |
| `SYNCENGINE_RESTATE_URL` | prod | Restate ingress |
| `SYNCENGINE_HANDLERS_ONLY` | scale-out | `1` on handlers tier to skip HTTP server |
| `SYNCENGINE_NO_BUS_SIGNALS` | scale-out | `1` on handlers tier if serve binary owns shutdown |
| `SYNCENGINE_PUBLIC_NATS_URL` | split-net | NATS URL the browser uses, when different from internal |
| `SYNCENGINE_PUBLIC_RESTATE_URL` | split-net | Same, for Restate |

## Persistence & backup

- **NATS JetStream** holds every table delta + every bus message. Streams are named `WS_<wsKey>` per workspace. Back up the JetStream data dir; restore by copying back.
- **Restate** holds workflow state, entity state, workspace registry, heartbeat status. Back up Restate's data dir.
- **Vite dist** is build output — regenerate with `syncengine build`.

Neither NATS nor Restate has a native point-in-time backup tool; use filesystem snapshots.

## Health checks

```bash
curl http://app:3000/_ready            # 200 when workspace service + bus runtime are attached
curl http://nats:8222/healthz          # NATS monitor
curl http://restate:9070/deployments   # Restate admin
```

Wire these into your load balancer / k8s probe config.

## Secrets

Services wrap SDKs and services read secrets from `process.env` at service-declaration time:

```ts
const stripe = new Stripe(process.env.STRIPE_SECRET!);
```

No syncengine-specific secret manager. Use your platform's (k8s Secrets, Doppler, 1Password Connect) — the service file reads env vars like any other Node app.

## Footguns

- **`PORT` means HTTP port, not Restate ingress.** If you're running single-process, `PORT` is the public 3000; Restate binds its own 8080 upstream.
- **WebSocket URLs need scheme matching.** Production over HTTPS needs `wss://`; mixed content fails silently in browsers. The edge tier auto-upgrades based on the incoming scheme.
- **Restate state is persistent.** A handler rename + restart leaves the old registration — use `syncengine state reset` or the admin API to force re-discovery. See the CLI guide.
- **Handlers tier restart drains in-flight bus invocations.** The `BusManager` installs SIGTERM handlers that stop cleanly. Rolling restarts are safe; hard kills can re-deliver in-flight messages (at-least-once delivery is the baseline).
- **Scale-out + dev don't mix.** `syncengine dev` always uses single-process. To test the scale-out split locally, use `docker-compose.serve.yml`.

## Links

- Spec: `docs/superpowers/specs/2026-04-17-syncengine-serve-design.md`
- Serve binary: `packages/serve-bin/`
- Bun edge: `packages/gateway-bun/`
- Smoke test: `scripts/smoke-docker.sh`, `scripts/smoke-docker.sh --buses`
