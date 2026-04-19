// Phase A, Task A3 — observability on SyncengineConfig.
//
// These tests verify the shape of `observability` carries through
// `config()` without widening or losing information. No runtime
// assertions — `config()` is an identity function — but the
// `satisfies` + property-read patterns catch type regressions that
// a bare `toEqual` would miss.

import { describe, it, expect, expectTypeOf } from 'vitest';
import { config, type SyncengineConfig, type ObservabilityConfig } from '..';

describe('config() — observability block', () => {
    it('accepts no observability block at all (backward compatible)', () => {
        const cfg: SyncengineConfig = config({
            workspaces: { resolve: () => 'default' },
        });
        expect(cfg.observability).toBeUndefined();
    });

    it('accepts exporter: false (the explicit-disable path)', () => {
        const cfg = config({
            workspaces: { resolve: () => 'default' },
            observability: { exporter: false },
        });
        expect(cfg.observability?.exporter).toBe(false);
    });

    it("accepts exporter: 'otlp' + full resource / sampling / autoInstrument", () => {
        const cfg = config({
            workspaces: { resolve: () => 'default' },
            observability: {
                serviceName: 'my-app',
                exporter: 'otlp',
                resource: { environment: 'prod', region: 'us-east-1', replica: 3 },
                sampling: { ratio: 0.25 },
                captureFieldValues: false,
                autoInstrument: ['fetch'],
            },
        });
        expect(cfg.observability?.serviceName).toBe('my-app');
        expect(cfg.observability?.sampling?.ratio).toBe(0.25);
        expect(cfg.observability?.autoInstrument).toEqual(['fetch']);
    });

    it('preserves the literal shape of the passed config (no widening)', () => {
        const cfg = config({
            workspaces: { resolve: () => 'default' },
            observability: { serviceName: 'literal-type', exporter: 'otlp' },
        });
        // The `const` inference inside config<const T>() should preserve
        // 'otlp' as the literal string, not widen to `string`.
        expectTypeOf(cfg.observability!.exporter).toEqualTypeOf<'otlp'>();
    });

    it("rejects an invalid exporter value at compile time", () => {
        // @ts-expect-error — only 'otlp' and false are allowed
        const _invalid: ObservabilityConfig = { exporter: 'jaeger' };
        void _invalid;
    });

    it('rejects an invalid autoInstrument entry at compile time', () => {
        // @ts-expect-error — only 'fetch' is supported today
        const _invalid: ObservabilityConfig = { autoInstrument: ['pg'] };
        void _invalid;
    });

    it('is exposed on SyncengineConfig as an optional field', () => {
        type Cfg = SyncengineConfig;
        expectTypeOf<Cfg>().toMatchTypeOf<{ observability?: ObservabilityConfig }>();
    });
});

describe('auth.provider (Plan 3)', () => {
    it('accepts an auth.provider on config()', () => {
        const cfg = config({
            workspaces: { resolve: () => 'default' },
            auth: {
                provider: {
                    name: 'stub',
                    verify: async () => ({ ok: true, user: { id: 'u1' } }),
                },
            },
        });
        expect(cfg.auth?.provider?.name).toBe('stub');
    });

    it('auth is optional entirely', () => {
        const cfg: SyncengineConfig = config({ workspaces: { resolve: () => 'default' } });
        expect(cfg.auth).toBeUndefined();
    });

    it('auth.verify and auth.provider can coexist', () => {
        const cfg = config({
            workspaces: { resolve: () => 'default' },
            auth: {
                verify: () => ({ id: 'alice' }),
                provider: {
                    name: 'stub',
                    verify: async () => ({ ok: true, user: { id: 'u1' } }),
                },
            },
        });
        expect(cfg.auth?.verify).toBeDefined();
        expect(cfg.auth?.provider).toBeDefined();
    });
});
