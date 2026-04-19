// Phase D, Task D2 — `.metrics.ts` file-based discovery.
//
// The plugin walks the configured src tree and finds every *.metrics.ts
// file; the full SSR-load path is exercised in apps/test via the dev
// server, so this test only covers the walker's conventions
// (extension match, excluded dirs, nesting).

import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverMetricsFiles } from '../observability';

function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'syncengine-metrics-disc-'));
}

describe('discoverMetricsFiles', () => {
    it('returns an empty list when the src dir does not exist', () => {
        const root = join(scratch(), 'does-not-exist');
        expect(discoverMetricsFiles(root)).toEqual([]);
    });

    it('picks up top-level *.metrics.ts files', () => {
        const root = scratch();
        writeFileSync(join(root, 'orders.metrics.ts'), 'export {};');
        writeFileSync(join(root, 'unrelated.ts'), 'export {};');

        const files = discoverMetricsFiles(root);
        expect(files).toHaveLength(1);
        expect(files[0]!).toMatch(/orders\.metrics\.ts$/);
    });

    it('walks subdirectories', () => {
        const root = scratch();
        mkdirSync(join(root, 'features', 'cart'), { recursive: true });
        writeFileSync(join(root, 'features', 'cart', 'cart.metrics.ts'), 'export {};');
        writeFileSync(join(root, 'features', 'orders.metrics.ts'), 'export {};');

        const files = discoverMetricsFiles(root).sort();
        expect(files).toHaveLength(2);
        expect(files[0]!).toMatch(/cart\.metrics\.ts$/);
        expect(files[1]!).toMatch(/orders\.metrics\.ts$/);
    });

    it('skips node_modules / .git / dist', () => {
        const root = scratch();
        mkdirSync(join(root, 'node_modules', 'some-dep'), { recursive: true });
        mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
        mkdirSync(join(root, 'dist'), { recursive: true });
        writeFileSync(join(root, 'node_modules', 'some-dep', 'x.metrics.ts'), 'export {};');
        writeFileSync(join(root, '.git', 'hooks', 'y.metrics.ts'), 'export {};');
        writeFileSync(join(root, 'dist', 'z.metrics.ts'), 'export {};');
        writeFileSync(join(root, 'real.metrics.ts'), 'export {};');

        const files = discoverMetricsFiles(root);
        expect(files).toHaveLength(1);
        expect(files[0]!).toMatch(/real\.metrics\.ts$/);
    });

    it('does not match files without the .metrics.ts suffix', () => {
        const root = scratch();
        writeFileSync(join(root, 'orders.metric.ts'), 'export {};'); // note: singular
        writeFileSync(join(root, 'metrics.ts'), 'export {};');       // no prefix
        writeFileSync(join(root, 'orders.metrics.tsx'), 'export {};'); // wrong ext

        expect(discoverMetricsFiles(root)).toEqual([]);
    });
});
