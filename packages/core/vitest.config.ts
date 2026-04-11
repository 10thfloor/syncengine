import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        pool: 'forks',
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/__tests__/**'],
        },
    },
});
