import { describe, it, expect } from 'vitest';
import { classifyErrorResponse } from '../bus-dispatcher.js';

describe('classifyErrorResponse', () => {
    describe('5xx infra — retriable', () => {
        it('502 → retriable', () => {
            const r = classifyErrorResponse(502, 'text/plain', 'bad gateway');
            expect(r.kind).toBe('retriable');
        });

        it('503 → retriable', () => {
            const r = classifyErrorResponse(503, 'text/plain', 'unavailable');
            expect(r.kind).toBe('retriable');
        });

        it('504 → retriable', () => {
            const r = classifyErrorResponse(504, 'text/plain', 'gateway timeout');
            expect(r.kind).toBe('retriable');
        });

        it('other 5xx → retriable', () => {
            const r = classifyErrorResponse(599, 'text/plain', 'mystery 5xx');
            expect(r.kind).toBe('retriable');
        });
    });

    describe('500 — terminal (Restate workflow failure)', () => {
        it('500 with JSON body → terminal with parsed message/code', () => {
            const body = JSON.stringify({ message: 'funds insufficient', code: 'FUNDS' });
            const r = classifyErrorResponse(500, 'application/json', body);
            expect(r.kind).toBe('terminal');
            if (r.kind === 'terminal') {
                expect(r.error.message).toBe('funds insufficient');
                expect(r.error.code).toBe('FUNDS');
            }
        });

        it('500 with JSON body (no code) → terminal with message only', () => {
            const body = JSON.stringify({ message: 'boom' });
            const r = classifyErrorResponse(500, 'application/json', body);
            expect(r.kind).toBe('terminal');
            if (r.kind === 'terminal') {
                expect(r.error.message).toBe('boom');
                expect(r.error.code).toBeUndefined();
            }
        });

        it('500 with non-JSON body → terminal with body as message', () => {
            const r = classifyErrorResponse(500, 'text/plain', 'some plain text error');
            expect(r.kind).toBe('terminal');
            if (r.kind === 'terminal') {
                expect(r.error.message).toBe('some plain text error');
            }
        });

        it('500 with empty body → terminal with fallback message', () => {
            const r = classifyErrorResponse(500, 'text/plain', '');
            expect(r.kind).toBe('terminal');
            if (r.kind === 'terminal') {
                expect(r.error.message).toBe('restate 500');
            }
        });

        it('500 with { }-leading body but no json content-type → still parses', () => {
            const r = classifyErrorResponse(500, 'text/plain', '{"message":"leaked"}');
            expect(r.kind).toBe('terminal');
            if (r.kind === 'terminal') {
                expect(r.error.message).toBe('leaked');
            }
        });
    });

    describe('429 — retriable', () => {
        it('429 → retriable', () => {
            const r = classifyErrorResponse(429, 'text/plain', 'too many');
            expect(r.kind).toBe('retriable');
            if (r.kind === 'retriable') {
                expect(r.reason).toContain('rate limited');
            }
        });
    });

    describe('4xx — legacy terminal marker', () => {
        it('4xx with application/terminal-error → terminal', () => {
            const body = JSON.stringify({ message: 'bad shape', code: 'SCHEMA' });
            const r = classifyErrorResponse(400, 'application/terminal-error+json', body);
            expect(r.kind).toBe('terminal');
            if (r.kind === 'terminal') {
                expect(r.error.message).toBe('bad shape');
                expect(r.error.code).toBe('SCHEMA');
            }
        });

        it('4xx with "terminal error" phrase in body → terminal', () => {
            const r = classifyErrorResponse(400, 'text/plain', 'terminal error: nope');
            expect(r.kind).toBe('terminal');
        });

        it('4xx with "terminal_error" phrase → terminal', () => {
            const r = classifyErrorResponse(400, 'text/plain', 'got terminal_error');
            expect(r.kind).toBe('terminal');
        });

        it('4xx without terminal marker → retriable', () => {
            const r = classifyErrorResponse(400, 'text/plain', 'bad request');
            expect(r.kind).toBe('retriable');
        });

        it('404 without marker → retriable', () => {
            const r = classifyErrorResponse(404, 'text/plain', 'not found');
            expect(r.kind).toBe('retriable');
        });
    });

    describe('body handling', () => {
        it('long body is truncated in retriable reason', () => {
            const body = 'x'.repeat(500);
            const r = classifyErrorResponse(503, 'text/plain', body);
            expect(r.kind).toBe('retriable');
            if (r.kind === 'retriable') {
                expect(r.reason.length).toBeLessThan(body.length + 50);
            }
        });

        it('long body is truncated in terminal message', () => {
            const body = 'x'.repeat(1000);
            const r = classifyErrorResponse(500, 'text/plain', body);
            expect(r.kind).toBe('terminal');
            if (r.kind === 'terminal') {
                expect(r.error.message.length).toBeLessThanOrEqual(500);
            }
        });

        it('malformed JSON with json content-type falls back to raw body', () => {
            const r = classifyErrorResponse(500, 'application/json', '{not-json');
            expect(r.kind).toBe('terminal');
            if (r.kind === 'terminal') {
                expect(r.error.message).toBe('{not-json');
            }
        });
    });
});
