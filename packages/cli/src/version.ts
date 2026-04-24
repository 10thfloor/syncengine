// Kept in sync with packages/cli/package.json "version" on every release.
// Bun's `build --compile` inlines this at build time, so the compiled
// binary reports a stable version even without runtime access to its own
// package.json.
export const VERSION = '0.1.0';
