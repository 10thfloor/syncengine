import { describe, it, expect, vi } from 'vitest';
import { entityRef } from '../entity-ref.js';
import { entity, integer } from '@syncengine/core';

const counter = entity('counter', {
    state: { value: integer() },
    handlers: {
        increment(state) { return { ...state, value: state.value + 1 }; },
        add(state, amount: number) { return { ...state, value: state.value + amount }; },
    },
});

function mockCtx(key: string) {
    const callLog: Array<{ method: string; args: unknown[] }> = [];
    const clientProxy = new Proxy({}, {
        get(_, method: string) {
            return (...args: unknown[]) => {
                callLog.push({ method, args });
                return Promise.resolve();
            };
        },
    });
    return {
        ctx: { key, objectClient: vi.fn().mockReturnValue(clientProxy) },
        callLog,
    };
}

describe('entityRef', () => {
    it('creates a proxy with handler methods', () => {
        const { ctx } = mockCtx('ws123/mykey');
        const ref = entityRef(ctx as any, counter, 'mykey');
        expect(typeof ref.increment).toBe('function');
        expect(typeof ref.add).toBe('function');
    });

    it('calls ctx.objectClient with correct entity name and full key', async () => {
        const { ctx } = mockCtx('ws123/mykey');
        const ref = entityRef(ctx as any, counter, 'mykey');
        await ref.increment();
        expect(ctx.objectClient).toHaveBeenCalledWith(
            { name: 'entity_counter' },
            'ws123/mykey',
        );
    });

    it('forwards handler args as a single array value (Restate wire format)', async () => {
        const { ctx, callLog } = mockCtx('ws123/mykey');
        const ref = entityRef(ctx as any, counter, 'mykey');
        await ref.add(42);
        expect(callLog).toHaveLength(1);
        expect(callLog[0].method).toBe('add');
        expect(callLog[0].args).toEqual([[42]]);
    });

    it('extracts workspace ID from ctx.key', async () => {
        const { ctx } = mockCtx('workspace-abc/entity-key');
        const ref = entityRef(ctx as any, counter, 'entity-key');
        await ref.increment();
        expect(ctx.objectClient).toHaveBeenCalledWith(
            { name: 'entity_counter' },
            'workspace-abc/entity-key',
        );
    });
});
