import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
    test: {
        pool: 'forks',
        // Worker-side modules import `virtual:syncengine/runtime-config` —
        // that's provided by the vite dev plugin at runtime. Under vitest
        // we alias it to a local stub so the test environment can import
        // worker sources for pure-function tests without booting the plugin.
        alias: {
            'virtual:syncengine/runtime-config': resolve(
                __dirname,
                'src/__tests__/runtime-config.stub.ts',
            ),
        },
    },
});
