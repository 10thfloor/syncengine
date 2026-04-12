/**
 * Plans the second esbuild pass that produces `dist/server/config.mjs`.
 *
 * This bundle is consumed by the production serve binary (`syncengine serve`)
 * and by edge adapters — they dynamic-import the default export to get the
 * user's `workspaces.resolve` and `auth.verify` callbacks.
 *
 * It exists separately from `dist/server/index.mjs` (the Restate endpoint)
 * for two reasons:
 *
 *   1. The Restate endpoint bundle pulls in the full server runtime
 *      (NATS, Restate SDK, entity registry, ~4 MB). The HTML server
 *      only needs the config — small bundles load faster and are
 *      lighter to cache.
 *
 *   2. The config bundle must not depend on `virtual:syncengine/runtime-config`
 *      or any other framework-internal module. Keeping the esbuild
 *      invocation free of aliases makes that constraint explicit — a
 *      config file that accidentally imports a virtual module fails
 *      the build instead of silently resolving to a stub.
 */

import { join } from 'node:path';

export interface ConfigBundlePlanInput {
    /** Absolute or appDir-relative path to the user's syncengine.config.ts,
     *  or null if no config file exists (we emit a stub then). */
    readonly configPath: string | null;
    /** Absolute path to <appDir>/dist. */
    readonly distDir: string;
    /** Absolute path to the app root (cwd for esbuild). */
    readonly appDir: string;
}

export type ConfigBundlePlan =
    | {
        readonly kind: 'esbuild';
        /** Args to pass to the esbuild binary. Caller invokes with
         *  `cwd: appDir`. */
        readonly args: readonly string[];
    }
    | {
        readonly kind: 'stub';
        /** Absolute path to write the stub file to. */
        readonly outPath: string;
        /** File content — a minimal ESM module matching SyncengineConfig. */
        readonly content: string;
    };

/**
 * The fallback config emitted when no user config file exists. Must be a
 * valid SyncengineConfig-shaped default export so the serve binary can
 * dynamic-import it unconditionally. Workspaces resolves to the literal
 * string 'default' — matches the single-workspace dev fallback.
 */
const STUB_CONTENT = `// Emitted by \`syncengine build\` when no syncengine.config.ts exists.
// Edit syncengine.config.ts in your app root to customize workspace
// resolution and auth.
export default {
  workspaces: {
    resolve: () => 'default',
  },
};
`;

export function planConfigBundle(input: ConfigBundlePlanInput): ConfigBundlePlan {
    const outPath = join(input.distDir, 'server', 'config.mjs');

    if (!input.configPath) {
        return { kind: 'stub', outPath, content: STUB_CONTENT };
    }

    return {
        kind: 'esbuild',
        args: [
            input.configPath,
            '--bundle',
            '--platform=node',
            '--format=esm',
            `--outfile=${outPath}`,
            '--target=node22',
        ],
    };
}
