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
        },
    },
});
