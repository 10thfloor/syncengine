#!/usr/bin/env node
// Thin launcher — spawns tsx to run the TypeScript CLI entry directly
// (no build step). We resolve tsx from the package's own node_modules so
// the launcher works regardless of the caller's CWD.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../src/index.ts');

// Prefer the locally-linked tsx binary; fall back to any tsx on PATH.
const localTsx = resolve(here, '..', 'node_modules', '.bin', 'tsx');
const tsxCmd = existsSync(localTsx) ? localTsx : 'tsx';

const child = spawn(tsxCmd, [entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
});

child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    // Fail-safe: if tsx exits with neither a code nor a signal (rare, but
    // can happen on abnormal terminations), treat it as a failure rather
    // than silently reporting success.
    else process.exit(code ?? 1);
});

// Forward SIGINT/SIGTERM to the child so the orchestrator can shut down
// gracefully when the user hits Ctrl-C.
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        if (!child.killed) child.kill(sig);
    });
}
