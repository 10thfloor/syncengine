Plan: syncengine — Vite plugin + embedded local dev

  A build-out plan for turning the current repo into a Meteor-style framework where the
  developer writes entity files, runs pnpm dev, and never sees NATS, Restate, ports, or
  Docker.

  Guiding principles

  1. Users think in workspaces and entities, nothing else. NATS subjects, Restate virtual  
  objects, stream naming, port allocation, and service registration are all internal. The
  word "NATS" should not appear in any user-facing type, config field, or error message.
  2. One command, zero prerequisites. pnpm install && pnpm dev is the entire onboarding. No
   Docker, no Homebrew, no manual service registration.
  3. Incremental, no big-bang rewrite. Every phase leaves the repo in a shippable state.
  The existing DBSP engine, Restate workspace service, NATS routing, and React store stay  
  exactly as they are — new code wraps them.
  4. Types flow end-to-end without codegen in the dev's face. No pnpm generate step. The
  Vite plugin does it invisibly, like Next.js route types.
  5. Production parity through the same plugin. vite build produces both the client bundle
  and the server deployment artifact. No separate "deploy path."

  Target user-facing surface

  Two files the developer ever touches:
  
  // syncengine.config.ts — project-level config
  import { defineConfig } from 'syncengine';
  
  export default defineConfig({
    workspaces: {
      // Given a request/session, return the workspace ID this user belongs to.
      // The framework scopes all entity state under this ID internally.
      resolve: async ({ request, user }) => {
        return `user:${user.id}`;  // or `org:${user.orgId}`, or URL-derived
      },
      retention: { maxAgeDays: 7 },
    },
    auth: {
      provider: 'clerk',  // or 'authjs' | 'custom'
    },
  });

  // src/entities/rooms.actor.ts — one file per entity
  import { defineEntity, id, text, integer, view, server } from 'syncengine';

  const rooms = table('rooms', {
    id: id(),
    name: text(),
    ownerId: text(),
  });

  export default defineEntity({
    table: rooms,
    views: {
      mine: view('mine', rooms).filter('ownerId', 'eq', '$user'),
    },
    handlers: server({
      async create(ctx, { name }: { name: string }) { /*... */ },
      async rename(ctx, { id, name }: { id: number; name: string }) { /* ...*/ },
    }),
  });

  Nothing else. No SyncConfig, no workspaceId, no natsUrl, no stream names, no manual
  Restate registration.

  Package structure

  syncengine/                       ← monorepo root
  ├── packages/
  │   ├── core/                     ← schema DSL, HLC, channels (was src/lib)
  │   ├── client/                   ← useEntity, RPC proxy, worker store
  │   ├── server/                   ← ctx factory, Restate adapters, orchestration
  │   ├── vite-plugin/              ← the plugin
  │   ├── cli/                      ← `syncengine dev` orchestrator
  │   ├── nats-bin/                 ← NATS binary downloader (postinstall)
  │   └── restate-bin/              ← Restate binary downloader (postinstall)
  ├── apps/
  │   └── example/                  ← the current syncengine app, migrated onto packages/*
  ├── dbsp-engine/                  ← unchanged, published as @syncengine/dbsp
  └── services/workspace/           ← becomes a generated artifact in .syncengine/, not
  hand-written

  The top-level syncengine package is a metapackage that re-exports core, client, and the  
  plugin so users can import { defineEntity, defineConfig } from 'syncengine' without
  knowing about the subpackages.

  Internal abstraction: how "workspaces" actually work

  The user writes workspaces.resolve once. Internally:

  1. On first request from a client, the Vite dev middleware (or the production edge
  function) calls workspaces.resolve({ request, user }) and gets back a string ID.
  2. That ID is hashed into a deterministic short form (e.g., first 16 chars of SHA-256) to
   produce an internal wsKey. This keeps NATS stream names and Restate keys bounded
  regardless of what the user returns.
  3. The internal wsKey is threaded everywhere — NATS subjects, Restate virtual object
  keys, the current SyncConfig.workspaceId. The user never sees it.
  4. Provisioning is lazy: the first time a given wsKey is seen, the framework calls the
  existing workspace.provision() Restate handler (at
  services/workspace/src/workspace.ts:97) to create the NATS stream. Subsequent requests
  skip it.
  5. The client receives a signed, short-lived workspace token from the server — it
  contains wsKey, permitted entities, and expiry. The existing SyncConfig.authToken
  mechanism stays, but it's now populated by the framework, not the user.

  Result: the SyncConfig interface at src/lib/store.ts:86 becomes entirely internal. Users
  never import it.

  Phases (each independently shippable and reviewable)

  Phase 0 — Monorepo refactor (no behavior change)

  Goal: move existing code into packages/* without changing any runtime behavior.

- Add pnpm workspaces (pnpm-workspace.yaml) with packages/*and apps/*
- Move src/lib/*→ packages/core/src/*, adjust packages/core/package.json exports
- Move src/workers/*, src/lib/store.ts parts → packages/client/src/*
- Move services/workspace/*→ packages/server/src/workspace/* (keep exporting the
  existing Restate object)
- Copy src/App.tsx / current app → apps/example/
- Everything still works: pnpm --filter example dev runs the app, docker-compose still
  boots services
- Success criteria: no test changes needed; the current app runs identically

  Phase 1 — Binary packages

  Goal: download NATS and Restate binaries lazily, cross-platform.

- packages/nats-bin/ — postinstall script that downloads nats-server from GitHub releases
   for the host platform, caches in ~/.cache/syncengine/bin/nats/<version>/
- packages/restate-bin/ — same, for restate-server
- Each package exports a binaryPath function that returns the absolute path to the cached
   binary, triggering download on first call if missing
- Platform detection handles: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64
- SHA-256 verification against pinned hashes in the package; bump package version to bump
   binary
- Success criteria: import { binaryPath } from '@syncengine/nats-bin' returns a working  
  binary path on all four host platforms, in both fresh install and cached scenarios

  Phase 2 — Dev orchestrator CLI (no Vite plugin yet)

  Goal: syncengine dev spawns everything needed, with clean logs and graceful shutdown.
  This replaces docker-compose for local dev, independent of the Vite plugin work.

- packages/cli/ with a single dev command
- Port allocation: defaults (4222 NATS, 8080 Restate ingress, 9070 admin, 5173 Vite) with
   fallback to random high ports if taken
- State dir: .syncengine/dev/{jetstream,restate,ports.json,pids.json}
- Startup sequence: NATS → wait for port → Restate → wait for /health → workspace service
   (still running as a child process here) → register workspace service with Restate admin
  API → Vite
- Log prefixes with color ([nats], [restate], [workspace], [vite])
- Graceful shutdown on SIGINT: reverse order, 3s timeout per child, SIGKILL fallback
- Leftover-process detection: on startup, check pids.json and offer to kill stragglers
- --fresh flag wipes state dir; --reset-streams recreates JetStreams only
- Auto-append .syncengine/ to .gitignore on first run
- Success criteria: pnpm dev in apps/example/ boots all services and Vite in under 5
  seconds on a warm cache; Ctrl-C leaves no orphaned processes

  Phase 3 — Generated connection module + hide the SyncConfig

  Goal: remove NATS/Restate URLs from the user-facing API. Framework threads them via a
  virtual module.

- New virtual module: virtual:syncengine/runtime-config that exports { natsUrl,
  restateUrl, workspaceToken }
- In dev, the CLI writes .syncengine/dev/runtime.json with the allocated ports; the
  plugin reads it and emits into the virtual module
- In production, the virtual module reads from environment variables set by the
  deployment target
- Update packages/client/src/store.ts so store() no longer accepts a sync config — it
  imports from virtual:syncengine/runtime-config instead
- The existing SyncConfig type moves to packages/core/src/internal/sync-config.ts and is
  no longer exported from the top-level package
- Success criteria: apps/example/ no longer passes any NATS/Restate config; it still
  syncs correctly

  Phase 4 — Minimal Vite plugin: discovery + module splitting

  Goal: .actor.ts files are discovered, server code is stripped from the client bundle, but
   no codegen yet. The plugin works but handlers are called via a hardcoded fetch path.

- packages/vite-plugin/ with hooks: config, configureServer, resolveId, load, transform  
- Use Vite 6 Environment API to declare client and server environments with different
  module graphs
- buildStart: glob src/**/*.actor.ts, parse with oxc-parser, register in an in-memory
  registry
- resolveId + load: for client environment, synthesize a module that exports only the
  schema/view metadata; server environment gets the original file
- transform: enforce that no non-actor client code statically imports a .actor.ts file
  outside the allowed pattern (steal Telefunc's boundary-check approach)
- configureServer: add /__syncengine/rpc/:entity/:method middleware that routes to a
  dev-mode RPC handler (fetches from the workspace service's Restate endpoint)
- Success criteria: an .actor.ts file with a handlers block imports cleanly on both
  sides; client bundle has zero bytes of handler code; RPC calls round-trip via the
  middleware

  Phase 5 — Typed RPC codegen

  Goal: end-to-end type safety. call.rename({ id: 'wrong' }) is a type error at the call
  site.

- Add ts-morph as a dep in packages/vite-plugin/
- On buildStart and on file change, use ts-morph to resolve each handler's parameter and
  return types into serializable type strings
- Emit those into the client virtual module as literal TypeScript type parameters on the
  createRpcProxy<...>(...) call
- Handle generics, imported types from the entity file, and Promise<T> unwrapping
- HMR: when an actor file changes, re-extract types and invalidate the virtual client
  module so Vite sends a client update
- Performance: only re-parse the files that changed; cache ts-morph project across
  invocations
- Success criteria: renaming a handler parameter in the actor file causes a TypeScript
  error in the consumer component without any manual step

  Phase 6 — defineEntity API + auto-generated Restate services

  Goal: one-file entities. The plugin generates the Restate virtual object at build time
  from the .actor.ts file.

- Finalize the defineEntity({ table, views, handlers }) API in packages/core
- Design the ctx passed to handlers — insert, update, delete, user(), authorize(),
  emit(), call(), run() — and wire each method to the existing DBSP merge + NATS publish +
  HLC tick paths in dbsp-engine/src/lib.rs:284 and services/workspace/src/workspace.ts:79
- Plugin generates .syncengine/server/<entity>.restate.ts for each actor file, wrapping  
  handlers in Restate virtual object adapters
- Generated files import from the actor file's server environment build, so handler code
  is shared (not duplicated)
- The existing hand-written workspace service at services/workspace/ becomes one of
  several generated services — or stays as the "root" workspace actor that everything else
  nests under
- Dev orchestrator auto-registers generated services with Restate on startup and on file
  change
- Success criteria: create a new messages.actor.ts in apps/example/, run pnpm dev, and
  the client can call call.send({ roomId, text }) without any manual wiring

  Phase 7 — HMR with Restate-assisted state preservation

  Goal: edit a handler, save the file, the new code runs against untouched actor state.
  Erlang-style, for free.

- handleHotUpdate: for .actor.ts changes, re-bundle the server artifact and re-register  
  with Restate's admin API
- Restate's durable state survives the re-registration because it's keyed by virtual
  object ID, not code version
- Client-side HMR: push a custom syncengine:entity-updated event; the client runtime
  re-subscribes views and clears any cached RPC type info
- Edge case: if the handler's input/output shape changed, existing in-flight calls in
  Restate's queue may deserialize into the old shape. Either error clearly or replay them  
  through a compat layer — probably just error, since this is dev.
- Success criteria: edit a handler body, save, call it from the React app without a page
  reload, observe the new behavior with state (counters, records) preserved

  Phase 8 — Workspace resolution

  Goal: the workspaces.resolve config actually drives workspace scoping. Users never touch
  workspace IDs.

- Vite dev middleware calls config.workspaces.resolve({ request, user }) on each RPC and
  sync connection
- Returned ID is hashed to an internal wsKey
- On first sight of a wsKey, call the existing workspace.provision() handler to create
  streams/state
- Issue a signed workspace token (JWT) to the client containing wsKey, permitted entity  
  names, expiry
- The client runtime (packages/client) picks up the token from a cookie or <meta> tag set
   by the dev middleware
- apps/example/ migrates to use workspaces.resolve instead of hardcoding a workspace ID
- Success criteria: two browser tabs logged in as different users see isolated state; the
   user code contains no workspace ID strings anywhere

  Phase 9 — Production build + deploy

  Goal: vite build produces deployable artifacts. syncengine deploy ships them.

- vite build with the plugin produces:
  - dist/client/ — static React bundle for any CDN/static host  
  - dist/server/ — a single Node entrypoint that registers all generated Restate services
   and exposes the dev middleware as a production handler
- Deployment targets to document: Fly.io (works today), Railway, self-hosted Docker,
  Vercel (for the client), any Node host (for the server bundle)
- Environment variables for production: SYNCENGINE_NATS_URL, SYNCENGINE_RESTATE_URL,
  SYNCENGINE_AUTH_SECRET — consumed by the virtual runtime-config module from Phase 3
- Optional: syncengine deploy fly command that runs fly deploy with a generated fly.toml,
   provisions managed NATS, etc.
- Keep infra/docker-compose.yml as the reference production topology
- Success criteria: pnpm build && pnpm start in a second shell runs the production bundle
   against locally running NATS/Restate and serves the app identically to dev

  What gets deleted / migrated

  The new layer adds abstractions on top of existing code. Very little gets deleted, but
  some things move:

  Current: src/lib/store.ts SyncConfig interface
  New location: packages/core/src/internal/
  Notes: No longer exported, framework-populated
  ────────────────────────────────────────
  Current: src/lib/channels.ts
  New location: packages/core/src/internal/channels.ts
  Notes: Still used internally, not exposed
  ────────────────────────────────────────
  Current: services/workspace/src/workspace.ts
  New location: Becomes the template for generated services
  Notes: Keep as-is during Phases 0–5, replace with generated output in Phase 6
  ────────────────────────────────────────
  Current: infra/docker-compose.yml
  New location: Kept as-is
  Notes: Purpose reframed: production-like testing, not dev
  ────────────────────────────────────────
  Current: src/lib/schema.ts
  New location: packages/core/src/schema.ts
  Notes: Extended with defineEntity, no breakage
  ────────────────────────────────────────
  Current: src/App.tsx
  New location: apps/example/src/App.tsx
  Notes: Migrated example app

  Open design decisions to make before Phase 4

  These are the decisions that will be hardest to change later. Worth explicit attention
  before writing code:

  1. ctx API shape inside handlers. What exactly does ctx.insert look like? Does it return
  the inserted record with generated IDs, or just void? Does ctx.authorize throw or return
  a result? The shape is the single thing every handler touches, so nail it first.
  2. ID generation. HLC-derived or opaque? Client-generated (enables optimistic inserts
  with stable IDs) or server-generated? The existing schema uses integer primary keys (id()
   in schema.ts:14) which suggests server-generated — but for optimistic mutations,
  client-generated with HLC is better. Probably: id() for server-gen, uid() for client-gen
  HLC, developer chooses per table.
  3. Where does auth validation happen? In the Vite dev middleware (before RPC routing), in
   Restate's ingress (via headers), or inside each handler's ctx.user()? Probably:
  middleware verifies the token, injects user into the request, ctx.user() reads it. Must
  match how production deployments work.
  4. Workspace isolation level. Is a workspace just a namespace (cheap, shared NATS
  stream), or a full tenant boundary (dedicated stream, dedicated Restate key, stricter
  isolation)? The existing code goes with "one NATS stream per workspace" which is strong
  isolation — keep that, but be aware it has a fan-out cost at high workspace counts.
  5. Entity-to-entity calls. When handler A calls handler B (ctx.call(OtherEntity,
  'method', args)), does it go through the real RPC path, or is it an in-process function  
  call? Real RPC gives you durability and observability for free but has latency.
  In-process is faster but harder to reason about. Probably: in-process for same-workspace,
   RPC for cross-workspace — but this needs thought.
  6. Schema migrations. The current code has migrations.ts — how does that interact with
  entity files? Does editing an entity file auto-generate a migration, or does the user
  still write them by hand? Probably: auto-detect schema drift, generate a migration stub
  the user reviews and commits. Separate sub-project, probably Phase 10.

  What's explicitly out of scope for this plan

- Distributed multi-region. The current architecture supports it, but shipping a
  geo-distributed deployment story is a separate body of work. For now, "production" means
  single-region Restate + NATS.
- Entity relationships / cascading deletes. The DBSP join operator handles read-side
  relationships. Write-side referential integrity is punted — users encode it in handlers  
  for now.
- Built-in auth. The plan integrates with Clerk/Auth.js/custom but doesn't include a
  first-party auth system. Clerk is the recommended default since it's Vercel-integrated
  and already in the repo's ecosystem.
- Observability UI. Restate has its own UI, NATS has nats top, DBSP view state is visible
   in the worker. A unified "syncengine devtools" panel is a Phase 11+ nice-to-have, not
  part of this plan.

  Shipping order and dependencies

  Phases 0–2 are fully independent and could be built in parallel by different people:
  monorepo refactor, binary packages, dev orchestrator. None depends on the others.

  Phase 3 depends on Phase 0 and Phase 2. Phase 4 depends on Phase 3. Phases 5, 6, 7 depend
   on Phase 4 and can partially overlap. Phase 8 depends on Phase 6. Phase 9 depends on all
   prior phases.

  The critical path to "minimum viable Meteor DX" is Phases 0 → 2 → 3 → 4 → 6. Once that's
  shipped, you have: one-file entities, one-command dev, no NATS/Restate in user code,
  typed RPC (without full type codegen — Phase 5 polishes that), and the existing reactive
  view story. Phases 5, 7, 8, 9 are refinements on that foundation.

  First concrete step

  Phase 0 — the monorepo refactor — is pure mechanical work and unblocks everything else.  
  I'd start there: pnpm-workspace.yaml, move files into packages/*, make sure apps/example/
   runs identically to the current app.

  After Phase 0, Phases 1 and 2 can start in parallel since binary packages and the CLI
  orchestrator don't depend on each other. That gets you to "no Docker for dev" as the
  first user-visible win, before any plugin work begins.

  ---
  Want me to start with Phase 0 now — actually do the monorepo refactor — or would you
  rather walk through one of the open design decisions (the ctx API shape is probably the  
  most load-bearing) before any code moves?
