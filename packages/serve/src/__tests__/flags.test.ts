import { describe, it, expect } from 'bun:test';
import { parseFlags, DEFAULT_FLAGS } from '../flags.ts';

describe('parseFlags', () => {
    it('returns defaults when no arguments are supplied', () => {
        const f = parseFlags([]);
        expect(f.distDir).toBe(DEFAULT_FLAGS.distDir);
        expect(f.port).toBe(DEFAULT_FLAGS.port);
        expect(f.host).toBe(DEFAULT_FLAGS.host);
        expect(f.logLevel).toBe(DEFAULT_FLAGS.logLevel);
        expect(f.logFormat).toBe(DEFAULT_FLAGS.logFormat);
        expect(f.resolveTimeoutMs).toBe(DEFAULT_FLAGS.resolveTimeoutMs);
        expect(f.shutdownDrainMs).toBe(DEFAULT_FLAGS.shutdownDrainMs);
        expect(f.assetsPrefix).toBe(DEFAULT_FLAGS.assetsPrefix);
        expect(f.maxBodyBytes).toBe(DEFAULT_FLAGS.maxBodyBytes);
    });

    it('spec-compliant defaults (locked from design §8)', () => {
        const f = parseFlags([]);
        expect(f.distDir).toBe('./dist');
        expect(f.port).toBe(3000);
        expect(f.host).toBe('0.0.0.0');
        expect(f.logLevel).toBe('info');
        expect(f.logFormat).toBe('json');
        expect(f.resolveTimeoutMs).toBe(5000);
        expect(f.shutdownDrainMs).toBe(15000);
        expect(f.assetsPrefix).toBe('/assets/');
        expect(f.maxBodyBytes).toBe(1_048_576);
    });

    it('accepts a positional distDir', () => {
        expect(parseFlags(['./my-dist']).distDir).toBe('./my-dist');
        expect(parseFlags(['/abs/path/dist']).distDir).toBe('/abs/path/dist');
    });

    it('parses --port as a number', () => {
        expect(parseFlags(['--port', '8080']).port).toBe(8080);
    });

    it('parses --port=VALUE form', () => {
        expect(parseFlags(['--port=8080']).port).toBe(8080);
    });

    it('parses --host', () => {
        expect(parseFlags(['--host', '127.0.0.1']).host).toBe('127.0.0.1');
        expect(parseFlags(['--host=0.0.0.0']).host).toBe('0.0.0.0');
    });

    it('parses --log-level', () => {
        expect(parseFlags(['--log-level', 'debug']).logLevel).toBe('debug');
        expect(parseFlags(['--log-level', 'warn']).logLevel).toBe('warn');
    });

    it('parses --log-format', () => {
        expect(parseFlags(['--log-format', 'pretty']).logFormat).toBe('pretty');
    });

    it('parses --resolve-timeout-ms', () => {
        expect(parseFlags(['--resolve-timeout-ms', '250']).resolveTimeoutMs).toBe(250);
    });

    it('parses --shutdown-drain-ms', () => {
        expect(parseFlags(['--shutdown-drain-ms', '30000']).shutdownDrainMs).toBe(30000);
    });

    it('parses --assets-prefix', () => {
        expect(parseFlags(['--assets-prefix', '/static/']).assetsPrefix).toBe('/static/');
    });

    it('parses --max-body-bytes', () => {
        expect(parseFlags(['--max-body-bytes', '2097152']).maxBodyBytes).toBe(2097152);
    });

    it('positional distDir before flags', () => {
        const f = parseFlags(['./out', '--port', '4000']);
        expect(f.distDir).toBe('./out');
        expect(f.port).toBe(4000);
    });

    it('positional distDir after flags', () => {
        const f = parseFlags(['--port', '4000', './out']);
        expect(f.distDir).toBe('./out');
        expect(f.port).toBe(4000);
    });

    it('later flag wins', () => {
        const f = parseFlags(['--port', '4000', '--port', '5000']);
        expect(f.port).toBe(5000);
    });

    it('rejects invalid --log-level values', () => {
        expect(() => parseFlags(['--log-level', 'chatty'])).toThrow(/log-level/);
    });

    it('rejects invalid --log-format values', () => {
        expect(() => parseFlags(['--log-format', 'yaml'])).toThrow(/log-format/);
    });

    it('rejects non-numeric --port', () => {
        expect(() => parseFlags(['--port', 'abc'])).toThrow(/port/);
    });

    it('rejects out-of-range --port', () => {
        expect(() => parseFlags(['--port', '0'])).toThrow(/port/);
        expect(() => parseFlags(['--port', '70000'])).toThrow(/port/);
    });

    it('rejects negative numeric flags', () => {
        expect(() => parseFlags(['--resolve-timeout-ms', '-1'])).toThrow();
        expect(() => parseFlags(['--max-body-bytes', '-100'])).toThrow();
    });

    it('rejects unknown flags loudly', () => {
        expect(() => parseFlags(['--nonsense'])).toThrow(/unknown/i);
    });

    it('rejects multiple positional arguments', () => {
        expect(() => parseFlags(['./a', './b'])).toThrow(/positional/i);
    });

    it('defaults --dev-errors to null (derive from NODE_ENV at runtime)', () => {
        expect(parseFlags([]).devErrors).toBeNull();
    });

    it('parses --dev-errors as true', () => {
        expect(parseFlags(['--dev-errors']).devErrors).toBe(true);
    });

    it('parses --no-dev-errors as false', () => {
        expect(parseFlags(['--no-dev-errors']).devErrors).toBe(false);
    });
});
