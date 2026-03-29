# DBSP Dashboard — Infrastructure

Local development infrastructure for the DBSP dashboard SaaS backend. Runs NATS (message relay with JetStream), Restate (durable workflow engine), and a workspace lifecycle service via Docker Compose.

## Prerequisites

- Docker and Docker Compose v2+
- `curl` and `jq` (for the operational scripts)
- Optional: [NATS CLI](https://github.com/nats-io/natscli) (`brew install nats-io/nats-tools/nats`) for stream inspection and testing

## Architecture

```
┌─────────────┐       ┌──────────────┐       ┌─────────────────────┐
│  Browser     │◄─ws──►│  NATS        │◄─────►│  Workspace Service  │
│  (DBSP+WASM) │       │  JetStream   │       │  (Restate handler)  │
└─────────────┘       └──────┬───────┘       └──────────┬──────────┘
                             │                          │
                             │                   ┌──────▼──────┐
                             │                   │   Restate    │
                             │                   │   Server     │
                             └───────────────────┴─────────────┘
```

Browser clients connect to NATS over WebSocket to publish and subscribe to workspace delta streams. The workspace service is a Restate virtual object that provisions and tears down JetStream streams, manages schema versions, and tracks workspace state durably.

## Quick Start

```bash
cd infra

# Start everything (NATS + Restate + workspace service)
./scripts/up.sh

# Create a workspace
./scripts/create-workspace.sh my-workspace

# Check its status
./scripts/workspace-info.sh my-workspace

# Tear it down when done
./scripts/delete-workspace.sh my-workspace

# Stop everything
./scripts/down.sh
```

## Services and Ports

| Service            | Port  | Purpose                                    |
|--------------------|-------|--------------------------------------------|
| NATS               | 4222  | Client connections (TCP)                   |
| NATS WebSocket     | 9222  | Browser client connections                 |
| NATS Monitoring    | 8222  | HTTP health and stats (`/healthz`, `/jsz`) |
| Restate Ingress    | 8080  | Invoke service handlers                    |
| Restate Admin      | 9070  | Register deployments, inspect state        |
| Restate Metrics    | 9071  | Prometheus metrics                         |
| Workspace Service  | 9080  | Restate service endpoint                   |

## Operational Scripts

All scripts are in `scripts/` and should be run from the `infra/` directory (they `cd` to the right place automatically).

### `up.sh`

Starts the full stack, waits for NATS and Restate to be healthy, then registers the workspace service deployment with Restate. Idempotent — safe to run multiple times.

```bash
./scripts/up.sh
```

### `down.sh`

Stops all containers and removes volumes (JetStream data, Restate journal). This is a clean teardown — all workspace state is lost.

```bash
./scripts/down.sh
```

### `create-workspace.sh`

Provisions a new workspace by calling the Restate workspace service. Creates a JetStream stream for the workspace's delta traffic.

```bash
./scripts/create-workspace.sh <workspace-id> [tenant-id]

# Examples:
./scripts/create-workspace.sh demo-1
./scripts/create-workspace.sh acme-dashboard acme-corp
```

The provisioning is idempotent — calling it again for an existing workspace returns its current state without creating a duplicate stream.

What it creates in NATS:

- Stream: `WS_<workspace_id>` (hyphens replaced with underscores)
- Subjects: `ws.<workspace-id>.>`
- Retention: 7 days, 100MB, 100K messages (oldest discarded first)

### `delete-workspace.sh`

Tears down a workspace: deletes the JetStream stream and marks the workspace as deleted in Restate state.

```bash
./scripts/delete-workspace.sh <workspace-id>
```

Durable — if the process crashes mid-teardown, Restate replays the operation on recovery.

### `workspace-info.sh`

Shows workspace state from Restate and stream info from NATS. If the `nats` CLI is installed, it shows detailed stream stats; otherwise falls back to the NATS HTTP monitoring endpoint.

```bash
./scripts/workspace-info.sh <workspace-id>
```

### `logs.sh`

Tails Docker Compose logs. Pass a service name to filter.

```bash
./scripts/logs.sh              # all services
./scripts/logs.sh nats         # NATS only
./scripts/logs.sh restate      # Restate only
./scripts/logs.sh workspace-service
```

### `nats-pub-test.sh`

Publishes a test message to a workspace's delta subject. Requires the `nats` CLI.

```bash
./scripts/nats-pub-test.sh <workspace-id> ['{"custom":"payload"}']
```

## NATS Subject Hierarchy

```
ws.<workspace-id>.deltas    # Z-set deltas (INSERT, DELETE mutations)
ws.<workspace-id>.schema    # Schema version change notifications (future)
ws.<workspace-id>.presence  # Client presence heartbeats (future)
```

Each workspace gets its own JetStream stream capturing all subjects under `ws.<workspace-id>.>`. Consumers (browser clients) maintain their own cursor position in the stream, so catch-up after offline periods is automatic.

## Workspace Service API

The workspace service is a Restate virtual object. Invoke handlers via HTTP through the Restate ingress:

### Provision

```bash
curl -X POST http://localhost:8080/workspace/<id>/provision \
  -H "Content-Type: application/json" \
  -d '{"tenantId": "my-tenant"}'
```

Optional field `maxAge` (seconds) overrides the default 7-day stream retention.

### Get State

```bash
curl -X POST http://localhost:8080/workspace/<id>/getState \
  -H "Content-Type: application/json" \
  -d '{}'
```

Returns the workspace state object:

```json
{
  "workspaceId": "demo-1",
  "tenantId": "default",
  "schemaVersion": 1,
  "streamName": "WS_demo_1",
  "createdAt": "2026-04-02T...",
  "status": "active"
}
```

Status values: `provisioning`, `active`, `teardown`, `deleted`.

### Bump Schema

```bash
curl -X POST http://localhost:8080/workspace/<id>/bumpSchema \
  -H "Content-Type: application/json" \
  -d '{"version": 2}'
```

Used to coordinate schema migrations across connected clients. Clients can subscribe to `ws.<id>.schema` (future) to detect version changes and reload.

### Teardown

```bash
curl -X POST http://localhost:8080/workspace/<id>/teardown \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Monitoring

### NATS

Health check: `curl http://localhost:8222/healthz`

Server info: `curl http://localhost:8222/varz`

JetStream stats: `curl http://localhost:8222/jsz?streams=true | jq .`

With the NATS CLI:

```bash
nats server info
nats stream ls
nats stream info WS_demo_1
nats consumer ls WS_demo_1
```

### Restate

Health: `curl http://localhost:9070/health`

List deployments: `curl http://localhost:9070/deployments | jq .`

List services: `curl http://localhost:9070/services | jq .`

Inspect invocations: `curl http://localhost:9070/invocations | jq .`

## Troubleshooting

**Workspace service fails to register with Restate**: Restate may still be starting. Re-run `./scripts/up.sh` — the registration step is idempotent.

**JetStream stream not created**: Check the workspace service logs (`./scripts/logs.sh workspace-service`). The NATS connection URL inside the container is `nats://nats:4222` (Docker internal DNS). If the service can't reach NATS, you'll see connection refused errors.

**Port conflicts**: If 4222, 8080, 8222, 9070, 9080, or 9222 are in use, edit `docker-compose.yml` to remap the host ports.

**Clean reset**: Run `./scripts/down.sh` to remove all volumes, then `./scripts/up.sh` to start fresh. All workspace state and JetStream data will be gone.

## What's Next

This infrastructure is the foundation for replacing the current BroadcastChannel-only tab sync with full cross-network sync. The remaining work:

1. **Browser NATS client** — connect the data worker to NATS over WebSocket (port 9222), publish deltas to `ws.<workspace-id>.deltas`, subscribe for inbound deltas from other devices.
2. **Consumer per device** — each browser creates a durable JetStream consumer so it can catch up after going offline without custom seq tracking.
3. **Auth gateway** — replace the permissive NATS auth with JWT-based per-workspace authorization (NATS supports this natively with account-scoped JWTs).
4. **Billing metering** — add a Restate service that counts deltas per tenant via a NATS consumer on `ws.*.deltas`.
