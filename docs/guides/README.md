# Syncengine Guides

Practical docs for building with syncengine primitives. Each guide opens with "when to reach for this", shows a 5-line declaration, covers the key API surface, calls out footguns, and points at the spec for deeper dives.

## Primitives

| Guide | What it's for |
|---|---|
| [entities.md](entities.md) | Actor-model state objects with pure handlers + state machines |
| [tables-and-channels.md](tables-and-channels.md) | CRDT-synced tables + channel routing for NATS subjects |
| [topics.md](topics.md) | Ephemeral pub/sub — cursors, presence, typing |
| [event-bus.md](event-bus.md) | Durable server-only domain events with subscribers, modifiers, and DLQ |
| [workflows.md](workflows.md) | Restate-durable orchestration across entities + services |
| [webhooks.md](webhooks.md) | Inbound HTTP with signature verification + idempotency |
| [heartbeats.md](heartbeats.md) | Durable scheduled work (interval or cron) |
| [services.md](services.md) | Hex-architecture driven ports for vendor SDKs |

## Meta

| Guide | What it covers |
|---|---|
| [config.md](config.md) | `syncengine.config.ts` — workspace resolution, auth, service overrides |
| [workspaces.md](workspaces.md) | Multi-tenancy model — workspaces as scope, not tenant |
| [testing.md](testing.md) | Unit / integration / smoke patterns; `createBusTestHarness` |
| [cli.md](cli.md) | `syncengine dev` / `start` / `build` / `serve` / `add` commands |
| [deployment.md](deployment.md) | Dev vs single-process vs scale-out production topologies |

## Start here

New to the framework? In order:

1. **[config.md](config.md)** — understand `workspaces.resolve`, the one thing every app wires up.
2. **[entities.md](entities.md)** — the biggest primitive; everything else orbits it.
3. **[tables-and-channels.md](tables-and-channels.md)** — how data flows from entity handlers to the browser.
4. **[workflows.md](workflows.md)** — when you need orchestration across entities.
5. **[event-bus.md](event-bus.md)** — when you need decoupled event fan-out.
6. **[testing.md](testing.md)** — write unit + integration tests for everything above.
7. **[deployment.md](deployment.md)** — when you're ready to ship.

The other guides — topics, webhooks, heartbeats, services — pull in when you need them.

## Beyond the guides

- **Specs** at `docs/superpowers/specs/` — authoritative design docs for each primitive. Read when a guide says "for deeper dives, see the spec".
- **Plans** at `docs/superpowers/plans/` — implementation plans for in-flight or shipped work. Useful for understanding how the current code got here.
- **Migrations** at `docs/migrations/` — upgrade paths between breaking API changes.
- **Kitchen-sink demo** at `apps/test/src/` — a real app exercising every primitive. Good to grep when a guide snippet isn't enough.
