// ── @syncengine/http-core ──────────────────────────────────────────────────
//
// Shared pipeline consumed by:
//   1. packages/vite-plugin/src/workspaces.ts (dev middleware)
//   2. packages/serve (production Bun binary)
//
// Both paths turn an inbound HTTP Request into a resolved workspace + user +
// injected HTML. Keeping the logic here is the single load-bearing decision
// that prevents dev/prod drift in workspace resolution semantics.

export { ProvisionCache } from './provision-cache.ts';
export { createHtmlInjector, type HtmlInjectorMeta } from './html-injector.ts';
export {
    resolveWorkspace,
    type ResolvePipelineOptions,
    type ResolutionResult,
} from './resolve.ts';
