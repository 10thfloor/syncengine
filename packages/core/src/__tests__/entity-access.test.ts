import { describe, it, expect } from 'vitest';
import { entity, integer, text, Access } from '../index';

describe('entity() access config', () => {
    it('accepts an access block alongside handlers', () => {
        const inventory = entity('inventory', {
            state: { stock: integer() },
            access: {
                restock: Access.deny,
                '*': Access.authenticated,
            },
            handlers: {
                restock(state) { return state; },
            },
        });
        expect(inventory.$access).toBeDefined();
        expect(inventory.$access?.restock).toBe(Access.deny);
        expect(inventory.$access?.['*']).toBe(Access.authenticated);
    });

    it('defaults $access to null when omitted', () => {
        const plain = entity('plain', {
            state: { count: integer() },
            handlers: {
                inc(state) { return state; },
            },
        });
        expect(plain.$access).toBeNull();
    });

    it('rejects an access entry that names a non-existent handler', () => {
        expect(() =>
            entity('bad', {
                state: { n: integer() },
                access: {
                    typo: Access.deny,
                },
                handlers: {
                    real(state) { return state; },
                },
            }),
        ).toThrow(/access key 'typo' does not match any handler/);
    });

    it('allows the wildcard "*" as a default', () => {
        const example = entity('example', {
            state: { count: integer() },
            access: {
                '*': Access.deny,
            },
            handlers: {
                something(state) { return state; },
            },
        });
        expect(example.$access?.['*']).toBe(Access.deny);
    });

    it('preserves text() state columns alongside the access block', () => {
        const orders = entity('orders', {
            state: { userId: text(), total: integer() },
            access: { cancel: Access.owner() },
            handlers: {
                cancel(state) { return { ...state, total: 0 }; },
            },
        });
        expect(orders.$access?.cancel.$kind).toBe('access');
    });
});
