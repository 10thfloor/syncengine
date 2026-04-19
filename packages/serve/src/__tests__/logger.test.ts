import { describe, it, expect } from 'bun:test';
import { createLogger } from '../logger.ts';

function capture(): {
    lines: string[];
    write: (s: string) => void;
} {
    const lines: string[] = [];
    return {
        lines,
        write(s: string) {
            for (const line of s.split('\n')) {
                if (line) lines.push(line);
            }
        },
    };
}

describe('createLogger (json)', () => {
    it('emits one JSON object per line', () => {
        const buf = capture();
        const log = createLogger({ level: 'info', format: 'json', write: buf.write });
        log.info({ event: 'html.ok', path: '/', status: 200 });
        log.info({ event: 'static.ok', path: '/app.js', status: 200 });
        expect(buf.lines).toHaveLength(2);
        expect(() => JSON.parse(buf.lines[0]!)).not.toThrow();
        expect(() => JSON.parse(buf.lines[1]!)).not.toThrow();
    });

    it('includes a timestamp and level on every line', () => {
        const buf = capture();
        const log = createLogger({ level: 'info', format: 'json', write: buf.write });
        log.info({ event: 'x' });
        const rec = JSON.parse(buf.lines[0]!) as { ts: string; level: string };
        expect(typeof rec.ts).toBe('string');
        expect(new Date(rec.ts).getTime()).toBeGreaterThan(0);
        expect(rec.level).toBe('info');
    });

    it('preserves caller-supplied fields verbatim', () => {
        const buf = capture();
        const log = createLogger({ level: 'info', format: 'json', write: buf.write });
        log.info({
            event: 'html.ok',
            request_id: 'abc',
            method: 'GET',
            path: '/',
            status: 200,
            duration_ms: 4,
            workspace_id: 'team-b',
        });
        const rec = JSON.parse(buf.lines[0]!) as Record<string, unknown>;
        expect(rec.event).toBe('html.ok');
        expect(rec.request_id).toBe('abc');
        expect(rec.method).toBe('GET');
        expect(rec.path).toBe('/');
        expect(rec.status).toBe(200);
        expect(rec.duration_ms).toBe(4);
        expect(rec.workspace_id).toBe('team-b');
    });

    it('respects log level — debug hidden at info', () => {
        const buf = capture();
        const log = createLogger({ level: 'info', format: 'json', write: buf.write });
        log.debug({ event: 'debug-only' });
        log.info({ event: 'info-level' });
        log.warn({ event: 'warn-level' });
        log.error({ event: 'error-level' });
        expect(buf.lines).toHaveLength(3);
        const events = buf.lines.map((l) => (JSON.parse(l) as { event: string }).event);
        expect(events).toEqual(['info-level', 'warn-level', 'error-level']);
    });

    it('log level "debug" shows everything', () => {
        const buf = capture();
        const log = createLogger({ level: 'debug', format: 'json', write: buf.write });
        log.debug({ event: 'a' });
        log.info({ event: 'b' });
        log.warn({ event: 'c' });
        log.error({ event: 'd' });
        expect(buf.lines).toHaveLength(4);
    });

    it('log level "error" hides warn/info/debug', () => {
        const buf = capture();
        const log = createLogger({ level: 'error', format: 'json', write: buf.write });
        log.debug({ event: 'a' });
        log.info({ event: 'b' });
        log.warn({ event: 'c' });
        log.error({ event: 'd' });
        expect(buf.lines).toHaveLength(1);
        expect((JSON.parse(buf.lines[0]!) as { event: string }).event).toBe('d');
    });

    it('adds the correct level per method', () => {
        const buf = capture();
        const log = createLogger({ level: 'debug', format: 'json', write: buf.write });
        log.debug({ event: 'a' });
        log.info({ event: 'b' });
        log.warn({ event: 'c' });
        log.error({ event: 'd' });
        const levels = buf.lines.map((l) => (JSON.parse(l) as { level: string }).level);
        expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
    });

    it('handles nested / non-primitive fields safely', () => {
        const buf = capture();
        const log = createLogger({ level: 'info', format: 'json', write: buf.write });
        log.info({
            event: 'html.err',
            err: { code: 'RESOLVE_FAILED', category: 'cli', message: 'boom' },
            tags: ['a', 'b'],
        });
        const rec = JSON.parse(buf.lines[0]!) as Record<string, unknown>;
        expect((rec.err as { code: string }).code).toBe('RESOLVE_FAILED');
        expect((rec.tags as string[])[0]).toBe('a');
    });
});

describe('createLogger (trace correlation)', () => {
    it('includes trace_id / span_id when the hook returns a context', () => {
        const buf = capture();
        const log = createLogger({
            level: 'info',
            format: 'json',
            write: buf.write,
            getTraceContext: () => ({
                traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                spanId: 'bbbbbbbbbbbbbbbb',
            }),
        });
        log.info({ event: 'x' });
        const rec = JSON.parse(buf.lines[0]!) as Record<string, unknown>;
        expect(rec.trace_id).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        expect(rec.span_id).toBe('bbbbbbbbbbbbbbbb');
    });

    it('omits trace_id / span_id when the hook returns undefined', () => {
        const buf = capture();
        const log = createLogger({
            level: 'info',
            format: 'json',
            write: buf.write,
            getTraceContext: () => undefined,
        });
        log.info({ event: 'x' });
        const rec = JSON.parse(buf.lines[0]!) as Record<string, unknown>;
        expect(rec.trace_id).toBeUndefined();
        expect(rec.span_id).toBeUndefined();
    });

    it('hook is called per-emit so mid-request span changes land on later lines', () => {
        const buf = capture();
        let current: { traceId: string; spanId: string } | undefined = undefined;
        const log = createLogger({
            level: 'info',
            format: 'json',
            write: buf.write,
            getTraceContext: () => current,
        });
        log.info({ event: 'before' });
        current = { traceId: 'cccccccccccccccccccccccccccccccc', spanId: 'dddddddddddddddd' };
        log.info({ event: 'during' });
        current = undefined;
        log.info({ event: 'after' });

        const [before, during, after] = buf.lines.map(
            (l) => JSON.parse(l) as Record<string, unknown>,
        );
        expect(before!.trace_id).toBeUndefined();
        expect(during!.trace_id).toBe('cccccccccccccccccccccccccccccccc');
        expect(after!.trace_id).toBeUndefined();
    });

    it('pretty format includes trace_id/span_id when present', () => {
        const buf = capture();
        const log = createLogger({
            level: 'info',
            format: 'pretty',
            write: buf.write,
            getTraceContext: () => ({
                traceId: 'abc12345abc12345abc12345abc12345',
                spanId: '1234567890abcdef',
            }),
        });
        log.info({ event: 'req' });
        const line = buf.lines[0]!;
        expect(line).toContain('trace_id=abc12345abc12345abc12345abc12345');
        expect(line).toContain('span_id=1234567890abcdef');
    });

    it('no hook configured → behaves as before (backward compatible)', () => {
        const buf = capture();
        const log = createLogger({ level: 'info', format: 'json', write: buf.write });
        log.info({ event: 'x' });
        const rec = JSON.parse(buf.lines[0]!) as Record<string, unknown>;
        expect(rec.trace_id).toBeUndefined();
        expect(rec.span_id).toBeUndefined();
    });
});

describe('createLogger (pretty)', () => {
    it('does NOT emit JSON per line', () => {
        const buf = capture();
        const log = createLogger({ level: 'info', format: 'pretty', write: buf.write });
        log.info({ event: 'html.ok', status: 200 });
        expect(buf.lines).toHaveLength(1);
        // Should not be parseable as JSON — pretty format is a human row
        expect(() => JSON.parse(buf.lines[0]!)).toThrow();
    });

    it('includes the event name and key fields', () => {
        const buf = capture();
        const log = createLogger({ level: 'info', format: 'pretty', write: buf.write });
        log.info({ event: 'html.ok', method: 'GET', path: '/', status: 200, duration_ms: 4 });
        const line = buf.lines[0]!;
        expect(line).toContain('html.ok');
        expect(line).toContain('GET');
        expect(line).toContain('/');
        expect(line).toContain('200');
    });
});
