import { describe, it, expect, vi } from 'vitest';
import { ClientSession } from '../client-session.js';

function mockWs() {
    return { send: vi.fn(), readyState: 1, OPEN: 1 } as any;
}

describe('ClientSession', () => {
    it('tracks channel subscriptions', () => {
        const session = new ClientSession('client-1', mockWs());
        session.subscribeChannel('ledger');
        expect(session.channels.has('ledger')).toBe(true);
        session.unsubscribeChannel('ledger');
        expect(session.channels.has('ledger')).toBe(false);
    });

    it('tracks entity subscriptions', () => {
        const session = new ClientSession('client-1', mockWs());
        session.subscribeEntity('inventory', 'headphones');
        expect(session.entities.has('inventory:headphones')).toBe(true);
        session.unsubscribeEntity('inventory', 'headphones');
        expect(session.entities.has('inventory:headphones')).toBe(false);
    });

    it('tracks topic subscriptions', () => {
        const session = new ClientSession('client-1', mockWs());
        session.subscribeTopic('cursors', 'global');
        expect(session.topics.has('cursors:global')).toBe(true);
        session.unsubscribeTopic('cursors', 'global');
        expect(session.topics.has('cursors:global')).toBe(false);
    });

    it('send() serializes and writes to WebSocket', () => {
        const ws = mockWs();
        const session = new ClientSession('client-1', ws);
        session.send({ type: 'ready' });
        expect(ws.send).toHaveBeenCalledWith('{"type":"ready"}');
    });

    it('send() skips when WebSocket is not open', () => {
        const ws = mockWs();
        ws.readyState = 3; // CLOSED
        const session = new ClientSession('client-1', ws);
        session.send({ type: 'ready' });
        expect(ws.send).not.toHaveBeenCalled();
    });
});
