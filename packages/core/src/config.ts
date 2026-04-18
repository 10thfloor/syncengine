// ── syncengine.config.ts DSL (PLAN Phase 8) ────────────────────────────────
//
// `defineConfig({...})` is a typed identity function used in the project
// root config file:
//
//     // apps/example/syncengine.config.ts
//     import { defineConfig } from 'syncengine';
//
//     export default defineConfig({
//         workspaces: {
//             resolve: async ({ request, user }) => {
//                 return `user:${user.id}`;
//             },
//         },
//     });
//
// The framework's Vite plugin loads this file once at startup, calls
// `config.workspaces.resolve({ request, user })` on every page request,
// hashes the returned string to a 16-hex-char `wsKey`, and threads that
// key through NATS subject names, Restate virtual-object keys, and the
// client runtime config. Users never see workspace ids in their code.

/**
 * Minimal user object seen by `workspaces.resolve`. Apps can extend
 * this via declaration merging for custom fields, but the framework
 * only relies on `id` for the default wsKey derivation.
 */
export interface SyncengineUser {
    readonly id: string;
    readonly [key: string]: unknown;
}

/**
 * Input to `workspaces.resolve`. `request` is the incoming page HTTP
 * request (or an RPC request for handler calls); `user` is whatever
 * auth plugin shape the app wires up. In dev, the plugin builds a
 * stub `{ id: '<query-param>' }` so the demo works without a real
 * auth provider.
 */
export interface WorkspaceResolveContext {
    readonly request: Request;
    readonly user: SyncengineUser;
}

export interface WorkspacesConfig {
    /**
     * Return the workspace id for this request+user. The string is
     * hashed internally to produce a bounded-length `wsKey` used for
     * NATS stream names and Restate keys, so the raw return value can
     * be anything stable: `user:${id}`, `org:${orgId}`,
     * URL-path-derived, etc.
     *
     * May be sync or async — the plugin awaits the result.
     */
    readonly resolve: (
        ctx: WorkspaceResolveContext,
    ) => string | Promise<string>;
}

export interface AuthVerifyContext {
    readonly request: Request;
}

export interface AuthConfig {
    /**
     * Runs on every HTML request before `workspaces.resolve`. The
     * returned user becomes `resolve()`'s `user` argument. Two ways to
     * say "not authenticated": return null/undefined or throw — both
     * are equivalent and degrade the request to anonymous (user.id =
     * 'anonymous'). Not a redirect hook.
     */
    readonly verify: (
        ctx: AuthVerifyContext,
    ) => SyncengineUser | null | undefined | Promise<SyncengineUser | null | undefined>;
}

export interface ServicesConfig {
    /**
     * Lazy import that returns a module of ServiceOverride exports.
     * Used to swap service adapters for test/staging environments.
     * The framework matches overrides to services by name.
     */
    readonly overrides?: () => Promise<Record<string, unknown>>;
}

/**
 * Observability configuration. Read at boot by `@syncengine/serve` and
 * `@syncengine/vite-plugin`, passed to `bootSdk` in `@syncengine/observe`.
 *
 * All fields optional. With no config at all, and no OTEL_* env vars set,
 * the framework still boots the SDK and uses OTLP/HTTP defaults
 * (localhost:4318) — users point it at a real APM by setting
 * `OTEL_EXPORTER_OTLP_ENDPOINT` or overriding `exporter` here.
 *
 * The type lives in core (not observe) so adding `observability` to
 * `config()` doesn't require a runtime dependency on OTel for projects
 * that never touch the observe package directly.
 */
export interface ObservabilityConfig {
    /** Overrides `OTEL_SERVICE_NAME`. Falls back to the service-name
     *  detector or `'syncengine-app'`. */
    readonly serviceName?: string;
    /** Source of truth for enable / disable.
     *  - `'otlp'` (default) boots the SDK with OTLP/HTTP exporters.
     *  - `false` disables entirely — seam helpers stay noops. */
    readonly exporter?: 'otlp' | false;
    /** Extra resource attributes merged on top of auto-detected ones. */
    readonly resource?: Readonly<Record<string, string | number | boolean>>;
    /** Parent-based sampler ratio. Defaults: 1.0 in non-production,
     *  0.1 in production. */
    readonly sampling?: { readonly ratio: number };
    /** Opt in to exporting entity field values on spans. Off by default —
     *  privacy-by-default; entity column *names* are always exported,
     *  values require opt-in. */
    readonly captureFieldValues?: boolean;
    /** Opt-in auto-instrumentation list. Currently supported: `'fetch'`
     *  (phase D4) — patches global fetch for outbound traceparent
     *  propagation. Default: `[]`. */
    readonly autoInstrument?: readonly 'fetch'[];
}

export interface SyncengineConfig {
    readonly workspaces: WorkspacesConfig;
    readonly auth?: AuthConfig;
    readonly services?: ServicesConfig;
    readonly observability?: ObservabilityConfig;
}

/**
 * Typed identity function. The return type preserves the literal
 * shape passed in so subsequent consumers (the Vite plugin, types
 * in test helpers, etc.) can reason about the exact config without
 * losing information to widening.
 */
export { config as defineConfig };

export function config<const T extends SyncengineConfig>(cfg: T): T {
    return cfg;
}
