# `syncengine serve` — Production HTTP Server Design (v2)

> Multi-workspace production entry point. Single compiled binary. Runs the
> user's `resolve()` + `auth.verify()` callbacks per HTML request, provisions
> workspaces on demand, serves static assets, streams observability data to
> standard sinks.

## Goals

- Close the multi-workspace production gap left open by today's build. Today a
  static `dist/` hosted on any CDN serves exactly one baked-in workspace.
  `syncengine serve` runs the same resolution pipeline the Vite middleware runs
  in dev, in a tiny binary designed for production.
- **Fast** where it matters (HTML transform + static serving) while running the
  user's TypeScript `resolve()` and `auth.verify()` callbacks at full V8 speed,
  not through a limited embedded interpreter.
- **Single-file deploy.** One binary per platform. No Node install, no package
  manager, no runtime dependencies other than the binary itself.
- **Shared pipeline with dev.** The dev-time Vite middleware and the production
  binary must call the exact same resolution code. Drift between dev and prod
  is the bug this feature exists to prevent — we will not reintroduce it.
- **Ecosystem-honest within documented constraints.** The user's callbacks can
  `import` pure-JS packages (`jose`, `zod`, `@supabase/supabase-js`, etc.).
  Native `.node` modules are not supported in v1 — explicitly called out.
- **Observable from day one.** JSON lines to stdout, request IDs on every log,
  OTel export auto-enabled when the standard env var is set.

## Non-Goals

- **TLS termination.** Document the upstream-terminator pattern (Caddy,
  Cloudflare, cloud LBs). No `--cert`/`--key` flags in v1.
- **Auth flows.** The binary verifies a token on each request; it does not run
  OAuth redirects, magic-link sends, password hashing, or session issuance.
  Those are app-level concerns served by app routes (inside `dist/` or a
  separate service).
- **Arbitrary HTTP/WebSocket endpoints.** Three routes only: static, HTML,
  health. No user-defined API endpoints. Typed server logic lives in Restate
  ingress; anything else runs as a separate service.
- **Multi-page builds.** v1 assumes a single-entry SPA: every non-static path
  serves `dist/index.html` (the "SPA fallthrough" pattern). Multi-page apps
  with multiple HTML entries are out of scope; see §13.
- **Admin UI.** Workspace listing, provisioning, inspection all stay in the
  existing devtools / Restate admin story.
- **Edge platform adapters.** Separate follow-up — `@syncengine/edge/vercel`,
  `@syncengine/edge/cloudflare`. This spec covers the long-running-binary
  shape only. Edge adapters reuse the shared core (§2.5) but run inside a
  different request shell.
- **Hot config reload.** `syncengine.config.ts` is loaded once at startup.
  Editing it requires a deploy (i.e., a process restart). No live reload
  without cycling the process.

---

## 1. Architecture at a glance

```
                          ┌──────────────────────────┐
                          │  syncengine serve (Bun)  │
HTTP request ───────────► │                          │
                          │  • static handler        │  ─── fs read ──►  dist/**
                          │  • HTML handler  ────────┼─► @syncengine/http-core
                          │    └─ (shared pipeline)  │      ├─ auth.verify
                          │  • /_health              │      ├─ workspaces.resolve
                          │  • /_ready               │      ├─ hashWorkspaceId
                          └──────────────────────────┘      ├─ provisionWorkspace
                                   │                         └─ injectMeta
                                   │                                   │
                                   │                                   ▼
                                   │                    ─── POST ─►  Restate ingress
                                   ▼
                      stdout JSON lines  +  OTel spans (if configured)


                             Same core used by the Vite plugin in dev:

                          ┌──────────────────────────┐
                          │  @syncengine/vite-plugin │
                          │   workspaces middleware  │  ────►  @syncengine/http-core
                          └──────────────────────────┘              (same module)
```

The binary is produced by `bun build --compile` from TypeScript in
`packages/serve/src/`. Cross-compiled per platform, shipped via a pinned-version
sidecar package `@syncengine/serve-bin` that mirrors the `nats-bin` /
`restate-bin` pattern — the CLI's `syncengine serve` subcommand resolves the
right binary from that package and spawns it.

---

## 2. New build artifact — `dist/server/config.mjs`

`syncengine build` currently emits `dist/server/index.mjs` — a ~4 MB bundle of
the Restate endpoint (entities, workflows, workspace service, NATS, Restate
SDK). The HTML server needs a smaller, isolated bundle of the config module so
it can dynamic-import the callbacks without pulling in the entire server
runtime.

New pass in `packages/cli/src/build.ts` after the existing esbuild step:

```ts
// Config-only bundle — isolated from the Restate server bundle.
// The user's syncengine.config.ts is an identity-function wrapper
// (defineConfig returns its arg unchanged, verified in
// packages/core/src/config.ts), so the emitted default export is
// literally the SyncengineConfig object.
execFileSync(esbuildBin, [
    configPath,                        // user's syncengine.config.ts
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${join(serverOutDir, 'config.mjs')}`,
    '--target=node22',
], { cwd: appDir, stdio: 'inherit' });
```

Notes on bundling:

- The `virtual:syncengine/runtime-config` alias used by the main server bundle
  is intentionally omitted here. A config file that imports from
  `virtual:syncengine/runtime-config` is a schema violation — flag at build
  time with a clear error rather than stub-resolve it.
- User deps are inlined. Most auth-adjacent libraries (`jose`, `zod`, etc.)
  are pure JS and bundle cleanly, typically adding 20–200 KB to `config.mjs`.
- **Native modules (`.node` files) are not supported in v1.** If esbuild
  encounters a native import, the build fails with a clear error directing
  users to pure-JS alternatives.

### Output contract

The bundler emits exactly what the user wrote, preserved through the identity
function:

```js
// dist/server/config.mjs  — emitted; server dynamic-imports this
export default {
  workspaces: {
    resolve: async ({ request, user }) => { ... },
  },
  auth: {                  // optional, omitted if the user did not declare
    verify: async ({ request }) => { ... },
  },
};
```

Startup in the serve binary:

```ts
const cfg = (await import(configPath)).default;
const resolveFn = cfg.workspaces.resolve;       // required; validate at boot
const authVerifyFn = cfg.auth?.verify ?? null;  // optional
```

One dynamic import at boot, cached for the process lifetime. Boot validates
that `resolveFn` is a function; missing or wrong shape → exit with
`CliCode.CONFIG_LOAD_FAILED`.

---

## 2.5. Shared pipeline — `@syncengine/http-core`

The dev Vite middleware and the production serve binary must never drift. We
extract the common logic into a new lightweight package both consume.

### Package scope

- Pure TypeScript, zero runtime deps beyond `@syncengine/core/http` (for
  `hashWorkspaceId`, `provisionWorkspace`, `injectMetaTags`, `escapeAttr`).
- Works in both Node (Vite plugin) and Bun (serve binary).
- No framework-specific code — takes a standard `Request`, returns data.

### Surface

```ts
// @syncengine/http-core
import type { SyncengineConfig } from '@syncengine/core';

export interface ResolvePipelineOptions {
  config: SyncengineConfig;
  restateUrl: string;
  resolveTimeoutMs?: number;            // default 5000
  provisionCache: ProvisionCache;       // caller owns lifecycle
}

export interface ResolutionResult {
  wsKey: string;
  workspaceId: string;
  user: SyncengineUser;
}

/** Run auth.verify + workspaces.resolve + provisionWorkspace for one
 *  incoming request. Throws SyncEngineError on any failure. */
export async function resolveWorkspace(
  request: Request,
  opts: ResolvePipelineOptions,
): Promise<ResolutionResult>;

/** In-process deduplicating cache for provisionWorkspace calls. See §3c. */
export class ProvisionCache {
  constructor(restateUrl: string);
  ensureProvisioned(wsKey: string): Promise<void>;
  has(wsKey: string): boolean;
}

/** Read `dist/index.html` once, return a reusable injector that
 *  splices workspace/NATS/Restate meta tags per request. */
export function createHtmlInjector(html: string): {
  inject(meta: {
    workspaceId: string;
    natsUrl: string;
    restateUrl: string;
    gatewayUrl?: string;
  }): string;
};
```

Both consumers shrink to thin adapters:

- `packages/vite-plugin/src/workspaces.ts` — maps Connect's `req`/`res` to a
  standard `Request`, calls `resolveWorkspace`, writes the injected HTML.
- `packages/serve/src/html.ts` — calls the same API directly inside a
  `Bun.serve` fetch handler.

### Why not fold this into `@syncengine/core`

`http-core` will need request/Response handling primitives that are fine in
servers but over-weight for the pure-logic core. Keeping it separate keeps
`@syncengine/core` browser-lean.

---

## 3. Request lifecycle

Every inbound HTTP request routes into one of four handlers. All methods
except GET/HEAD on HTML routes get 405. Non-routed paths get 404.

### 3a. `GET /_health` — liveness probe

Returns `200 { ok: true, uptime_ms }` unconditionally. No side effects. For
Kubernetes, this is the `livenessProbe`. Never calls `resolve()` or Restate.

### 3b. `GET /_ready` — readiness probe

Returns `200 { ok: true }` once the process has finished boot (config loaded,
listening, one successful Restate reachability check). Otherwise `503`. For
Kubernetes, this is the `readinessProbe`. Split from `/_health` so orchestrators
can distinguish "process alive" from "process ready to accept traffic."

### 3c. Static files

Matched by path: anything ending in a known static extension
(`.js`, `.css`, `.map`, `.wasm`, `.png`, `.jpg`, `.svg`, `.ico`, `.woff2`,
`.json`, etc.) or under a configurable prefix (default `/assets/`).

1. Resolve path relative to `dist/` with path-traversal guard (no `..`, no
   absolute). Reject anything outside `dist/` with 404.
2. `Bun.file(absPath)` — zero-copy stream.
3. Content-type from file extension.
4. `ETag: W/"<sha256>"` generated at startup (one pass over `dist/`) and
   cached in memory.
5. Honor `If-None-Match`; reply 304 on hit.
6. `Cache-Control: public, max-age=31536000, immutable` for hashed asset paths
   matching `*-[hash].ext` (Vite's default output format).
7. `Cache-Control: no-cache` for anything else (correctness over perf for
   non-hashed assets).
8. Static files are **public** — auth is not checked. User-uploaded or
   sensitive content should not be served from this handler; use your own
   service behind auth instead.

### 3d. HTML (SPA fallthrough)

The fallback handler for every non-static, non-health path. Serves
`dist/index.html` with per-request meta tags injected.

1. If method is not `GET` or `HEAD`, return `405 Method Not Allowed` with
   plaintext body. Writes to HTML routes go to Restate ingress or the user's
   own service; this handler does not accept them.
2. Generate a request ID (from `X-Request-Id` if present, else generated via
   ULID).
3. Delegate the pipeline to `http-core.resolveWorkspace(request, opts)`:
   - Runs `auth.verify({ request })` if configured; soft-fails to
     `{ id: 'anonymous' }`.
   - Runs `workspaces.resolve({ request, user })` with a configurable
     timeout (`--resolve-timeout-ms`, default 5000).
   - Hashes the returned id to a wsKey.
   - Calls `provisionCache.ensureProvisioned(wsKey)` — see §3e below.
4. Call `injector.inject({...})` to splice the meta tags into `index.html`.
5. Return the injected HTML with `Cache-Control: no-cache`, the standard
   COOP/COEP headers if Vite emitted them, and `X-Request-Id` echoed back.
6. Emit one structured log line (see §6).

### 3e. Provision cache semantics

The provision cache **deduplicates in-flight provisioning**, not just
completed provisioning. Thundering-herd (100 tabs, cold binary, same
workspace) produces one Restate call, not 100.

```ts
class ProvisionCache {
  #inflight = new Map<string, Promise<void>>();

  async ensureProvisioned(wsKey: string): Promise<void> {
    const existing = this.#inflight.get(wsKey);
    if (existing) return existing;
    const p = provisionWorkspace(this.#restateUrl, wsKey);
    this.#inflight.set(wsKey, p);
    try { await p; }
    catch (err) { this.#inflight.delete(wsKey); throw err; }
    // Retain the resolved promise → future calls short-circuit immediately.
  }
}
```

Cache lifetime is the process lifetime. External workspace deletion /
reset → the binary must be restarted to re-provision, which is correct for
long-lived binaries deployed per tag.

### 3f. Error handling

Any throw from auth, resolve, or provision, or a missing/invalid return:

```ts
} catch (err) {
    const sErr = err instanceof SyncEngineError
        ? err
        : errors.cli(CliCode.RESOLVE_FAILED, {
            message: err instanceof Error ? err.message : String(err),
            cause: err instanceof Error ? err : new Error(String(err)),
          });
    log.error({
      event: 'html.err',
      request_id,
      err_code: sErr.code,
      err_category: sErr.category,
      err_message: sErr.message,
    });
    if (devMode) {
      return new Response(formatError(sErr, { color: false }), {
        status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return new Response('workspace resolution failed — see server logs', {
      status: 500,
    });
}
```

Error codes and categories:

| Condition | Code | Category | Status |
|---|---|---|---|
| User code in `resolve()` threw | `RESOLVE_FAILED` | `cli` | 500 |
| `resolve()` exceeded timeout | `RESOLVE_TIMEOUT` (new) | `cli` | 504 |
| `resolve()` returned non-string / empty | `RESOLVE_FAILED` | `cli` | 500 |
| `auth.verify()` threw | *(logged, soft-failed)* | — | — |
| `provisionWorkspace()` HTTP failure | `RESTATE_UNREACHABLE` | `connection` | 502 |
| `provisionWorkspace()` timed out | `RESTATE_UNREACHABLE` | `connection` | 504 |

`RESOLVE_TIMEOUT` is a new `CliCode` added as part of this feature.

### 3g. Graceful shutdown

On `SIGTERM`:

1. Stop accepting new connections (Bun.serve `.stop()`).
2. Emit `{ event: 'shutdown.begin', inflight: <n> }`.
3. Wait for in-flight requests to drain, up to a configurable deadline
   (`--shutdown-drain-ms`, default 15000).
4. Emit `{ event: 'shutdown.done', drained: <n>, timed_out: <n> }`.
5. Exit 0.

`SIGINT` follows the same path (useful for local debugging). A second
`SIGINT` / `SIGTERM` during draining skips the wait and exits immediately.

---

## 4. `resolve()` contract

### Signature

```ts
type ResolveContext = {
  request: Request;            // standard Fetch API Request
  user: SyncengineUser;
};

workspaces.resolve: (ctx: ResolveContext) => string | Promise<string>;
```

### Inputs guaranteed to the callback

- `request.url` — full URL including query string.
- `request.headers` — `Headers` object (cookies, auth headers, etc.).
- `request.method` — always `'GET'` or `'HEAD'` (non-GET/HEAD is rejected
  before `resolve()` runs; see §3d).
- `user` — whatever `auth.verify()` returned, or `{ id: 'anonymous' }` if auth
  was not configured or failed.

### Output

A non-empty string. Hashed via `hashWorkspaceId()` into the wsKey. Common
shapes: `'default'`, `` `user:${user.id}` ``, `` `org:${orgId}` ``, a URL path
segment, any stable string.

### Error semantics

- Non-string / empty return → `CliCode.RESOLVE_FAILED`, 500.
- Throw inside `resolve()` → wrapped in `CliCode.RESOLVE_FAILED` with the
  original as `cause`, 500.
- Timeout (default 5 s, configurable via `--resolve-timeout-ms`) →
  `CliCode.RESOLVE_TIMEOUT`, 504.

### Consistency with dev

The Vite middleware and the serve binary both route through
`http-core.resolveWorkspace`, so the behavior is identical — same inputs,
same error codes, same edge cases.

---

## 5. `auth.verify()` contract

### Shape

```ts
// syncengine.config.ts
export default defineConfig({
  workspaces: { resolve: ... },
  auth: {
    // Runs on EVERY HTML request. No internal caching — if you need
    // caching across requests, implement it yourself inside verify.
    verify: async ({ request }) => {
      const token = request.headers
        .get('cookie')?.match(/session=([^;]+)/)?.[1];
      if (!token) return null;
      try {
        const claims = await verifyJwt(token, process.env.JWT_SECRET);
        return { id: claims.sub, email: claims.email };
      } catch {
        return null;
      }
    },
  },
});
```

### Rules

- **Optional.** Omit `auth` entirely → every request proceeds as
  `{ id: 'anonymous' }`.
- **Called on every HTML request.** No internal caching. Users implement
  their own caching (Redis, in-process LRU, etc.) inside `verify` if needed.
- **Static requests skip auth.** Static assets served from `dist/` are public
  in v1; auth gates the workspace state exposed by the SPA, not the bundle.
- **Runs before `resolve()`.** Its return value becomes the `user` argument
  to `resolve`.
- **Two ways to say "not authenticated":** return `null` / `undefined`, or
  throw. Both are equivalent — request proceeds as anonymous. A throw logs
  one `{ event: 'auth.err' }` entry; a null return does not.
- **Returned user shape:**
  ```ts
  type SyncengineUser = {
    readonly id: string;           // required; short stable identifier
    readonly [k: string]: unknown; // anything else the app cares about
  };
  ```
  `user.id === 'anonymous'` is reserved for the fallback. User code should
  use any other string for authenticated users.
- **Pure-JS only.** No `.node` native modules. Use `jose` instead of
  native-mode `jsonwebtoken`, `argon2-browser` instead of `bcrypt`, etc.
  Enforced at build time — esbuild fails if it encounters a native import.
- **Not a redirect hook.** `verify()` cannot redirect the browser. For
  login-required pages, enforce inside `resolve()`:
  ```ts
  resolve: ({ user }) => {
    if (user.id === 'anonymous') throw new Error('must be logged in');
    return `user:${user.id}`;
  };
  ```
  That throws → `CliCode.RESOLVE_FAILED` → 500. The SPA then decides how to
  recover (typically via a global error boundary that navigates to a login
  route).

### Why throws are soft

Auth failures are the 90th-percentile case (stale cookies, expired tokens).
Hard-500'ing the page is user-hostile. Soft-failing lets the SPA decide
whether to show a login prompt, a public view, or a redirect.

---

## 6. Observability

### JSON-lines logs (always on)

Every request produces at most one log line at INFO plus optional per-substep
lines at DEBUG. Schema:

```json
{
  "ts": "2026-04-17T14:22:01.123Z",
  "level": "info",
  "event": "html.ok" | "html.err" | "static.ok" | "static.404"
         | "health.ok" | "ready.ok" | "ready.fail"
         | "auth.err" | "resolve.err" | "provision.err"
         | "shutdown.begin" | "shutdown.done",
  "request_id": "01HZABC...",
  "method": "GET",
  "path": "/",
  "status": 200,
  "duration_ms": 4,
  "bytes_out": 2394,
  "workspace_id": "team-b",
  "user_id": "alice",
  "err_code": "RESOLVE_FAILED",    // only on *.err events
  "err_category": "cli",
  "err_message": "..."
}
```

Flags: `--log-level <error|warn|info|debug>` (default `info`),
`--log-format <json|pretty>` (default `json`; `pretty` is for local use only).

### OTel (opt-in)

If `OTEL_EXPORTER_OTLP_ENDPOINT` is set at startup, OTel tracing is enabled
via `@opentelemetry/sdk-node`. Spans emitted per HTML request:

- Root span: `syncengine.http.html` with attrs `http.method`, `http.route`,
  `http.status_code`, `syncengine.workspace_id`, `syncengine.user_id`,
  `syncengine.request_id`.
- Child spans: `auth.verify`, `workspaces.resolve`, `provisionWorkspace`.

Standard OTel env vars respected: `OTEL_SERVICE_NAME` (default
`syncengine-serve`), `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_EXPORTER_OTLP_PROTOCOL`.

**Size note.** `bun build --compile` may or may not fully tree-shake the
OTel SDK when the env var is unset. A Phase 1 spike measures binary size in
both configurations; if the difference exceeds ~5 MB, we gate the OTel import
on a build-time flag (`SYNCENGINE_OTEL=1`) so size-sensitive builds can opt
out. Until the spike runs, assume OTel code may be resident even when unused.

### Metrics

Out of scope for v1. Log lines carry `duration_ms` per request; any log
pipeline (Loki + LogQL, DataDog, etc.) can derive metrics. First-party
Prometheus/StatsD endpoints may come after real usage surfaces needs.

---

## 7. Binary packaging

### Build (CI)

`scripts/build.ts` in `packages/serve/`:

```ts
const targets = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-arm64',
  'bun-windows-x64',
];

for (const target of targets) {
  await $`bun build --compile --minify --sourcemap=none \
    --target=${target} \
    --outfile=dist/syncengine-serve-${target.slice(4)} \
    src/index.ts`;
}
```

CI workflow (`.github/workflows/serve.yml`) triggers on tag push, runs the
matrix, uploads binaries to the GitHub release. Each artifact accompanied by
its SHA256 and (for Windows) wrapped in a `.zip`.

### Distribution (`@syncengine/serve-bin`)

Mirrors `@syncengine/restate-bin` and `@syncengine/nats-bin`. Publishes a
`binaryPath()` function that:

1. Detects host platform/arch.
2. Looks up URL + sha256 from a pinned version manifest baked into the
   package at publish time.
3. Downloads to `~/.cache/syncengine/bin/serve/<version>/` if not cached.
4. Verifies sha256.
5. Returns the absolute path to the executable.

### CLI subcommand

```ts
// packages/cli/src/serve.ts
import { binaryPath as serveBinary } from '@syncengine/serve-bin';

export async function serveCommand(args: string[]): Promise<void> {
  const distDir = resolvePositional(args) ?? './dist';
  if (!existsSync(distDir)) {
    throw errors.cli(CliCode.BUILD_OUTPUT_MISSING, {
      message: `${distDir} not found`,
      hint: 'Run `syncengine build` first.',
    });
  }
  const bin = await serveBinary();
  const child = spawn(bin, [distDir, ...passThrough(args)], { stdio: 'inherit' });
  await onExit(child);
}
```

Users invoke via `syncengine serve ./dist --port 3000`.

---

## 8. Configuration surface

### Flags on the binary

| Flag                    | Default       | Purpose                                |
|-------------------------|---------------|----------------------------------------|
| *(positional)*          | `./dist`      | path to build output                   |
| `--port <n>`            | `3000`        | listen port (**prod default — dev's vite uses 5173**) |
| `--host <h>`            | `0.0.0.0`     | bind host                              |
| `--log-level <l>`       | `info`        | `error\|warn\|info\|debug`             |
| `--log-format <f>`      | `json`        | `json\|pretty`                         |
| `--resolve-timeout-ms`  | `5000`        | per-request `resolve()` timeout        |
| `--shutdown-drain-ms`   | `15000`       | SIGTERM drain deadline                 |
| `--assets-prefix <p>`   | `/assets/`    | hashed-asset path prefix               |
| `--max-body-bytes <n>`  | `1048576`     | request body cap (HTML handler)        |

### Env vars

| Variable                          | Required | Purpose                          |
|-----------------------------------|----------|----------------------------------|
| `SYNCENGINE_RESTATE_URL`          | yes      | Restate ingress (provision + meta) |
| `SYNCENGINE_NATS_URL`             | yes      | NATS WebSocket URL (meta)        |
| `SYNCENGINE_GATEWAY_URL`          | no       | Gateway WS URL (meta)            |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | no       | enables OTel when set            |
| `OTEL_SERVICE_NAME`               | no       | OTel service name                |
| `OTEL_RESOURCE_ATTRIBUTES`        | no       | OTel resource attrs              |
| `OTEL_EXPORTER_OTLP_HEADERS`      | no       | OTel auth/headers                |
| `NODE_ENV`                        | no       | `development` surfaces error details in 500 responses |

Missing required env vars at startup → immediate exit with
`CliCode.ENV_MISSING`, platform-formatted error.

### Memory budget

Target under 100 MB RSS under steady state at 1 k req/s on a mid-range
laptop. Enforced by Phase 4 regression tests. No hard limit at runtime; this
is a ceiling to watch for regressions, not a user-facing knob.

---

## 9. Deployment recipes (shipped with v1)

### 9a. Single-container

Before building the image:

```bash
syncengine build                           # produces ./dist
curl -L -o syncengine-serve https://github.com/.../releases/download/vX.Y.Z/syncengine-serve-linux-x64
chmod +x syncengine-serve
```

Then:

```dockerfile
FROM scratch
COPY syncengine-serve /syncengine-serve
COPY dist /dist
ENV SYNCENGINE_RESTATE_URL=http://restate:8080
ENV SYNCENGINE_NATS_URL=ws://nats:9222
ENTRYPOINT ["/syncengine-serve", "/dist", "--port", "3000"]
EXPOSE 3000
```

Container image: ~35 MB (binary) + size of `dist/`.

### 9b. HTML edge + Restate core

- `syncengine-serve` running on a small always-on VPS (Fly.io / Railway /
  Render / ECS), private-networked to the Restate cluster.
- Cloudflare or a CDN in front caches the 99 % static traffic.
- HTML responses round-trip to the origin; typically 1–5 ms on a well-placed
  origin, well-masked by the CDN on static.

### 9c. Separate tiers

- Multiple `syncengine-serve` instances behind a load balancer. Stateless —
  the provision cache is in-process but idempotent, so cold instances
  correct-by-construction from request one.
- Restate cluster on its own tier, reachable via private network.

Documented in `docs/deployment.md` as part of Phase 5.

---

## 10. Testing surface

- **Unit:** meta-tag injection, path-traversal rejection, content-type
  mapping, ETag generation, log-line shape, 405 on wrong methods, 404 on
  unknown paths.
- **Integration:** spin up `syncengine-serve` bound to `apps/notepad/dist`,
  curl-drive with varying `?workspace=` params, assert different wsKeys in
  the injected meta tags, assert a Restate mock received exactly one
  `provisionWorkspace` call per unique wsKey under concurrent load (validates
  the in-flight dedup from §3e), assert error responses contain the formatted
  error in dev mode and generic text in prod mode.
- **Load:** `oha -n 100000 -c 50` against the HTML endpoint and a static
  endpoint; publish P50/P95/P99 + req/s in the README. Regression target:
  P99 HTML under 10 ms, P99 static under 2 ms on a mid-range laptop.
- **Chaos:** kill the Restate ingress during a soak; HTML requests 502 with
  `CliCode.RESTATE_UNREACHABLE`; static keeps serving; recovery flips HTML
  back to 200 within one request.
- **Shutdown:** drive 50 concurrent in-flight HTML requests, send SIGTERM,
  confirm all drain successfully inside the deadline and the process exits 0.

---

## 11. Open questions (answerable in implementation)

- **HTMLRewriter vs read-transform** for meta injection. HTMLRewriter is
  streaming and handles malformed HTML; read-transform is simpler and for
  sub-10 KB HTML the perf delta is irrelevant. **Starting position:**
  read-transform; switch to HTMLRewriter if the 10 KB assumption breaks.
- **OTel tree-shaking** (see §6). Phase 1 spike verifies whether `bun build
  --compile` eliminates the OTel SDK when the env var is unset. If it
  doesn't, add a build-time opt-in flag.
- **Config reload.** Explicitly non-goal (§Non-Goals). Worth revisiting if
  operators demand it; the right answer is probably a SIGHUP handler that
  re-imports `config.mjs`, but that opens questions about in-flight requests
  and semantics. Defer.
- **CORS.** Not handled by the binary. Cross-origin concerns (NATS WS,
  Restate HTTP) are upstream — the SPA is served same-origin and the
  external services run their own CORS policies. Document; no code.
- **Native module support for user callbacks.** v1 refuses at build time.
  Could be revisited if a compelling native-mode dep emerges; would require
  shipping `.node` artifacts alongside the binary, which erases the
  single-file deploy benefit. Unlikely to change.

---

## 12. Success criteria (v1 ships when…)

1. `syncengine serve ./apps/notepad/dist` boots in < 100 ms and serves
   `http://localhost:3000/` end-to-end, injecting the right workspace meta
   tag for each of `?workspace=alice`, `?workspace=bob`, `?workspace=default`.
2. `@syncengine/http-core` is the single source of resolve/auth/provision
   logic. Both the Vite plugin and the serve binary consume it; neither
   contains duplicated logic.
3. Killing the Restate ingress produces a formatted 502 with the platform
   error system's output. Bringing it back produces a 200 on the next
   request, and the request does not re-trigger a fresh provision (cached).
4. Concurrent load on a cold binary with 100 tabs hitting the same workspace
   produces exactly one `provisionWorkspace` call (validates §3e dedup).
5. Load test reports P99 HTML ≤ 10 ms and P99 static ≤ 2 ms on a
   50-concurrent load from the same host.
6. `docker build` on the provided multi-stage Dockerfile produces an image
   under 50 MB; the running container responds to `/_health` and `/_ready`.
7. Writing an `auth.verify()` callback that reads a cookie and returns
   `{ id, email }` works end-to-end: the `user` arg to `resolve()` is the
   returned object, and an expired cookie cleanly degrades to anonymous.
8. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` causes spans to appear in a local
   Jaeger instance without code changes, with the expected span hierarchy.
9. `syncengine build` emits `dist/server/config.mjs` next to `index.mjs`,
   and a native `.node` import in `syncengine.config.ts` fails the build
   with a clear pointer to pure-JS alternatives.
10. SIGTERM during active load drains all in-flight HTML requests within
    `--shutdown-drain-ms` and exits 0.
11. Binary released for `linux-x64`, `linux-arm64`, `darwin-arm64`,
    `windows-x64` via `@syncengine/serve-bin`.

---

## 13. Downstream work (out of scope for this spec)

- **Edge adapters** (`@syncengine/edge/vercel`, `@syncengine/edge/cloudflare`,
  `@syncengine/edge/netlify`) — reuse `@syncengine/http-core`, run inside a
  different request shell. Separate spec.
- **Multi-page app support.** Route-table config declaring which paths serve
  which HTML entries. Natural extension once someone needs it.
- **Metrics endpoint** (Prometheus / OpenMetrics) — after logs-to-metrics
  aggregation proves insufficient.
- **Workspace-scoped rate limiting.** Upstream WAF (Cloudflare, etc.)
  handles this in most deployments. Revisit if organic need surfaces.
- **Live config reload.** Explicitly deferred; restart-based deploy is the
  paved path.
- **First-party TLS.** For single-VPS deployments where users don't want a
  separate Caddy. `--cert` / `--key` flags would be trivial to add; non-goal
  today to keep the v1 scope tight.

---

## Appendix: diff from v1

Changes incorporating review feedback:

- Added §2.5 shared-pipeline package (`@syncengine/http-core`) to prevent
  dev/prod drift.
- Verified `defineConfig` is an identity function (see §2 note).
- Hardened native-module stance: v1 pure-JS only, enforced at build time
  (§2, §5, §12).
- Made SPA-only explicit in Non-Goals and §3d; multi-page moved to §13.
- Added §3g graceful-shutdown behavior and `--shutdown-drain-ms` flag.
- Added §3b `/_ready` readiness probe distinct from `/_health`.
- Added §3e in-flight provisioning dedup with `Map<wsKey, Promise>`.
- Added 405/404 behavior for non-GET/HEAD and unknown paths (§3d).
- Softened OTel tree-shake claim to a Phase 1 spike outcome (§6).
- Tightened error-code taxonomy (§3f) and added `RESOLVE_TIMEOUT` as a new
  `CliCode`.
- Made §5 explicit: `auth.verify` runs on every request, no internal
  caching, static is unauth'd.
- Added `--max-body-bytes`, `--shutdown-drain-ms` flags and memory target
  (§8).
- Dockerfile prelude (§9a) showing the build-then-package sequence.
- Success criteria expanded from 8 to 11 checkpoints covering dedup,
  shutdown, build-time native-module failure.
