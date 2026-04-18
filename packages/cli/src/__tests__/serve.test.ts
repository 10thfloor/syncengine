import { describe, it, expect, vi } from 'vitest';
import { runServe, type RunResolution } from '../serve.ts';

const BIN: RunResolution = Object.freeze({ kind: 'binary', path: '/cache/syncengine-serve' });
const SOURCE: RunResolution = Object.freeze({ kind: 'source', path: '/repo/packages/serve/src/index.ts' });

describe('runServe', () => {
    it('resolves once and dispatches the spawn with the same Resolution', async () => {
        const spawn = vi.fn().mockResolvedValue(0);
        const resolve = vi.fn().mockResolvedValue(BIN);

        const code = await runServe(['./dist', '--port', '3000'], {
            resolve,
            spawn,
        });

        expect(code).toBe(0);
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(1);
        const [res, args] = spawn.mock.calls[0]!;
        expect(res).toEqual(BIN);
        expect(args).toEqual(['./dist', '--port', '3000']);
    });

    it('hands a source Resolution straight through to spawn (no sentinel encoding)', async () => {
        const spawn = vi.fn().mockResolvedValue(0);
        await runServe(['./dist'], {
            resolve: async () => SOURCE,
            spawn,
        });
        const [res] = spawn.mock.calls[0]!;
        expect(res).toEqual(SOURCE);
    });

    it('forwards the spawned binary exit code', async () => {
        const code = await runServe([], {
            resolve: async () => BIN,
            spawn: async () => 42,
        });
        expect(code).toBe(42);
    });

    it('passes through no args when none are supplied', async () => {
        const spawn = vi.fn().mockResolvedValue(0);
        await runServe([], {
            resolve: async () => BIN,
            spawn,
        });
        expect(spawn.mock.calls[0]?.[1]).toEqual([]);
    });

    it('surfaces binary-resolution errors as a non-zero exit', async () => {
        const resolve = vi.fn().mockRejectedValue(new Error('bin not found'));
        const spawn = vi.fn();

        const code = await runServe([], {
            resolve,
            spawn,
            stderr: () => {},
        });

        expect(code).not.toBe(0);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('writes a helpful diagnostic to stderr on resolution failure', async () => {
        let captured = '';
        await runServe([], {
            resolve: async () => { throw new Error('bin not found'); },
            spawn: async () => 0,
            stderr: (msg) => { captured += msg; },
        });
        expect(captured).toContain('bin not found');
    });

    it('preserves flag ordering when passing through', async () => {
        const spawn = vi.fn().mockResolvedValue(0);
        await runServe(
            ['--port', '4000', './dist', '--log-format=pretty'],
            { resolve: async () => BIN, spawn },
        );
        expect(spawn.mock.calls[0]?.[1]).toEqual([
            '--port', '4000', './dist', '--log-format=pretty',
        ]);
    });
});
