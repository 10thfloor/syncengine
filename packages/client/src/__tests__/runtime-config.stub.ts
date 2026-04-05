// Static stub for `virtual:syncengine/runtime-config`.
//
// The Vite plugin synthesizes this module at bundle time from
// `.syncengine/dev/runtime.json` (dev) or `SYNCENGINE_*` env vars (prod).
// Under vitest the plugin isn't in play, so vitest.config.ts aliases the
// virtual specifier to this file. Tests that don't actually boot the worker
// (everything that exercises `validateStoreConfig`, StoreConfig typing, etc.)
// can safely rely on these stub values.

export const workspaceId = 'test-workspace';
export const natsUrl = 'ws://localhost:9222';
export const restateUrl = 'http://localhost:8080';
export const authToken: string | undefined = undefined;
