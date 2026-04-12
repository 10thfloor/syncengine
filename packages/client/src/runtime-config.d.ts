/**
 * Type declarations for the `virtual:syncengine/runtime-config` module
 * provided by `@syncengine/vite-plugin`.
 *
 * The plugin emits these values as an ES module at build time, reading
 * from `.syncengine/dev/runtime.json` in dev or `SYNCENGINE_*` env vars
 * in production. This declaration lets TypeScript resolve the import
 * without needing the plugin to be loaded at typecheck time.
 */

declare module 'virtual:syncengine/runtime-config' {
    export const workspaceId: string;
    export const natsUrl: string;
    export const gatewayUrl: string;
    export const restateUrl: string;
    export const authToken: string | null;
}
