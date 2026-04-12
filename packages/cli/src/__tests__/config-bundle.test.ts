import { describe, it, expect } from 'vitest';
import { planConfigBundle } from '../config-bundle.ts';

describe('planConfigBundle', () => {
    it('returns an esbuild plan when a user config path is provided', () => {
        const plan = planConfigBundle({
            configPath: 'syncengine.config.ts',
            distDir: '/repo/apps/notepad/dist',
            appDir: '/repo/apps/notepad',
        });

        expect(plan.kind).toBe('esbuild');
        if (plan.kind !== 'esbuild') return;
        expect(plan.args).toContain('syncengine.config.ts');
        expect(plan.args).toContain('--bundle');
        expect(plan.args).toContain('--platform=node');
        expect(plan.args).toContain('--format=esm');
        expect(plan.args).toContain('--target=node22');
        expect(plan.args.some((a) => a.startsWith('--outfile='))).toBe(true);
        expect(plan.args.some((a) => a.endsWith('/dist/server/config.mjs'))).toBe(true);
    });

    it('targets the outfile under distDir/server/config.mjs', () => {
        const plan = planConfigBundle({
            configPath: 'syncengine.config.ts',
            distDir: '/repo/apps/x/dist',
            appDir: '/repo/apps/x',
        });
        if (plan.kind !== 'esbuild') throw new Error('expected esbuild plan');
        const outfile = plan.args.find((a) => a.startsWith('--outfile='));
        expect(outfile).toBe('--outfile=/repo/apps/x/dist/server/config.mjs');
    });

    it('preserves the user configPath exactly as passed in (relative or absolute)', () => {
        const absolute = planConfigBundle({
            configPath: '/repo/apps/x/syncengine.config.ts',
            distDir: '/repo/apps/x/dist',
            appDir: '/repo/apps/x',
        });
        if (absolute.kind !== 'esbuild') throw new Error('expected esbuild plan');
        expect(absolute.args).toContain('/repo/apps/x/syncengine.config.ts');

        const relative = planConfigBundle({
            configPath: 'syncengine.config.ts',
            distDir: '/repo/apps/x/dist',
            appDir: '/repo/apps/x',
        });
        if (relative.kind !== 'esbuild') throw new Error('expected esbuild plan');
        expect(relative.args).toContain('syncengine.config.ts');
    });

    it('returns a stub plan when no config path is provided', () => {
        const plan = planConfigBundle({
            configPath: null,
            distDir: '/repo/apps/x/dist',
            appDir: '/repo/apps/x',
        });

        expect(plan.kind).toBe('stub');
        if (plan.kind !== 'stub') return;
        expect(plan.outPath).toBe('/repo/apps/x/dist/server/config.mjs');
        // Stub must emit the SyncengineConfig default-export shape the
        // serve binary dynamic-imports. Must include `workspaces.resolve`
        // returning a usable fallback (typically 'default') and should
        // NOT include auth (optional; serve binary tolerates omitted).
        expect(plan.content).toContain('export default');
        expect(plan.content).toContain('workspaces');
        expect(plan.content).toContain('resolve');
    });

    it('stub content evaluates to a valid SyncengineConfig with resolve() returning a non-empty string', async () => {
        const plan = planConfigBundle({
            configPath: null,
            distDir: '/tmp/dist',
            appDir: '/tmp',
        });
        if (plan.kind !== 'stub') throw new Error('expected stub plan');

        // Evaluate the stub as an ES module via a data URL.
        const dataUrl = 'data:text/javascript;base64,' +
            Buffer.from(plan.content, 'utf8').toString('base64');
        const mod = await import(dataUrl) as {
            default: {
                workspaces: {
                    resolve: (ctx: unknown) => string | Promise<string>;
                };
            };
        };
        const result = await mod.default.workspaces.resolve({
            request: new Request('http://localhost/'),
            user: { id: 'anonymous' },
        });
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
    });

    it('esbuild plan does NOT include the runtime-config alias used by the main server bundle', () => {
        // Config files should never import virtual:syncengine/runtime-config.
        // If someone does, esbuild should fail (rather than silently resolving
        // to a stub). So no alias should appear in the config bundle args.
        const plan = planConfigBundle({
            configPath: 'syncengine.config.ts',
            distDir: '/repo/dist',
            appDir: '/repo',
        });
        if (plan.kind !== 'esbuild') throw new Error('expected esbuild plan');
        expect(plan.args.some((a) =>
            a.includes('virtual:syncengine/runtime-config'),
        )).toBe(false);
    });
});
