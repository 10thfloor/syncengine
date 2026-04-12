import { describe, it, expect, vi } from 'vitest';
import { runServe } from '../serve.ts';

describe('runServe', () => {
    it('resolves the binary once and spawns it with the passed args', async () => {
        const spawn = vi.fn().mockResolvedValue(0);
        const resolveBin = vi.fn().mockResolvedValue('/cache/syncengine-serve');

        const code = await runServe(['./dist', '--port', '3000'], {
            resolveBinary: resolveBin,
            spawn,
        });

        expect(code).toBe(0);
        expect(resolveBin).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(1);
        const [bin, spawnArgs] = spawn.mock.calls[0]!;
        expect(bin).toBe('/cache/syncengine-serve');
        expect(spawnArgs).toEqual(['./dist', '--port', '3000']);
    });

    it('forwards the spawned binary exit code', async () => {
        const code = await runServe([], {
            resolveBinary: async () => '/bin/fake',
            spawn: async () => 42,
        });
        expect(code).toBe(42);
    });

    it('passes through no args when none are supplied', async () => {
        const spawn = vi.fn().mockResolvedValue(0);
        await runServe([], {
            resolveBinary: async () => '/bin/fake',
            spawn,
        });
        expect(spawn.mock.calls[0]?.[1]).toEqual([]);
    });

    it('surfaces binary-resolution errors as a non-zero exit', async () => {
        const resolveBin = vi.fn().mockRejectedValue(new Error('bin not found'));
        const spawn = vi.fn();

        const code = await runServe([], {
            resolveBinary: resolveBin,
            spawn,
            // Capture stderr for assertion instead of printing.
            stderr: () => {},
        });

        expect(code).not.toBe(0);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('writes a helpful diagnostic to stderr on resolution failure', async () => {
        let captured = '';
        await runServe([], {
            resolveBinary: async () => { throw new Error('bin not found'); },
            spawn: async () => 0,
            stderr: (msg) => { captured += msg; },
        });
        expect(captured).toContain('bin not found');
    });

    it('preserves flag ordering when passing through', async () => {
        const spawn = vi.fn().mockResolvedValue(0);
        await runServe(
            ['--port', '4000', './dist', '--log-format=pretty'],
            { resolveBinary: async () => '/x', spawn },
        );
        expect(spawn.mock.calls[0]?.[1]).toEqual([
            '--port', '4000', './dist', '--log-format=pretty',
        ]);
    });
});
