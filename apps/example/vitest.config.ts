import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'node',
        include: [
            'src/**/__tests__/**/*.test.ts',
            'src/**/*.test.ts',
            '../../packages/*/src/**/__tests__/**/*.test.ts',
        ],
        exclude: ['node_modules', 'dist'],
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, './src'),
            // The client store.ts imports `virtual:syncengine/runtime-config`,
            // which is synthesized by the Vite plugin at bundle time. Under
            // vitest the plugin isn't in play, so we alias the specifier to a
            // static stub that provides the same exports.
            'virtual:syncengine/runtime-config': resolve(
                __dirname,
                '../../packages/client/src/__tests__/runtime-config.stub.ts',
            ),
        },
    },
});
