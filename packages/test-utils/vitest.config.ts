import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        pool: 'forks',
        poolOptions: {
            forks: {
                execArgv: ['--experimental-wasm-modules'],
            },
        },
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/__tests__/**'],
        },
    },
});
