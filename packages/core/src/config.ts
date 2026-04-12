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

export interface SyncengineConfig {
    readonly workspaces: WorkspacesConfig;
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
