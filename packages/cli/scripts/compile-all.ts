/**
 * Cross-compile the CLI for every platform the install.sh script serves.
 *
 * Each target produces a single self-contained executable that embeds
 * the Bun runtime. Output goes to `dist/<platform>-<arch>/syncengine`
 * (and `...syncengine.exe` for windows) so the release workflow can
 * pack each one into a tarball / zip per platform.
 *
 * Usage:
 *   pnpm -F @syncengine/cli compile:all
 *   # or with a subset:
 *   SYNCENGINE_TARGETS=darwin-arm64,linux-x64 pnpm -F @syncengine/cli compile:all
 *
 * Bun's cross-compile is a pure packaging operation — it just bundles
 * the right precompiled runtime for the target triple. No emulation,
 * no Rosetta, safe to run on any host.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const ENTRY = join(PKG_ROOT, 'src/index.ts');
const DIST = join(PKG_ROOT, 'dist');

interface Target {
    /** Human label used in the dist path and install.sh matcher. */
    readonly label: string;
    /** Bun --target value. See https://bun.com/docs/bundler/executables */
    readonly bunTarget: string;
    /** `.exe` suffix for windows. */
    readonly ext?: string;
}

const ALL_TARGETS: Target[] = [
    { label: 'darwin-arm64', bunTarget: 'bun-darwin-arm64' },
    { label: 'darwin-x64',   bunTarget: 'bun-darwin-x64' },
    { label: 'linux-arm64',  bunTarget: 'bun-linux-arm64' },
    { label: 'linux-x64',    bunTarget: 'bun-linux-x64' },
    { label: 'windows-x64',  bunTarget: 'bun-windows-x64', ext: '.exe' },
];

function selectedTargets(): Target[] {
    const env = process.env.SYNCENGINE_TARGETS?.trim();
    if (!env) return ALL_TARGETS;
    const labels = new Set(env.split(',').map((s) => s.trim()).filter(Boolean));
    const picked = ALL_TARGETS.filter((t) => labels.has(t.label));
    const unknown = [...labels].filter((l) => !ALL_TARGETS.some((t) => t.label === l));
    if (unknown.length > 0) {
        console.error(`Unknown targets: ${unknown.join(', ')}`);
        console.error(`Valid: ${ALL_TARGETS.map((t) => t.label).join(', ')}`);
        process.exit(1);
    }
    if (picked.length === 0) {
        console.error('SYNCENGINE_TARGETS filtered to zero targets.');
        process.exit(1);
    }
    return picked;
}

function compile(target: Target): Promise<void> {
    const outDir = join(DIST, target.label);
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `syncengine${target.ext ?? ''}`);

    const args = [
        'build',
        '--compile',
        '--minify',
        '--sourcemap=none',
        `--target=${target.bunTarget}`,
        `--outfile=${outFile}`,
        ENTRY,
    ];

    console.log(`▸ compiling ${target.label}...`);
    const started = Date.now();

    return new Promise((ok, fail) => {
        const child = spawn('bun', args, { cwd: PKG_ROOT, stdio: 'inherit' });
        child.on('exit', (code) => {
            if (code === 0) {
                const elapsed = ((Date.now() - started) / 1000).toFixed(1);
                console.log(`  ✓ ${target.label} → ${outFile} (${elapsed}s)`);
                ok();
            } else {
                fail(new Error(`bun build failed for ${target.label} (exit ${code})`));
            }
        });
        child.on('error', fail);
    });
}

async function main(): Promise<void> {
    if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
    mkdirSync(DIST, { recursive: true });

    const targets = selectedTargets();
    for (const target of targets) {
        await compile(target);
    }

    console.log(`\nDone. Artifacts in ${DIST}/`);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
