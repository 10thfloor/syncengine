import { defineEntity, text } from '@syncengine/core';

/**
 * Shared cursor positions — a single entity instance ('global') holds
 * every active user's mouse position as a JSON map. Restate serializes
 * writes so there's no lost-update problem, and every mutation
 * broadcasts to all connected clients via NATS.
 */
export const cursors = defineEntity('cursors', {
    state: {
        positions: text(),
    },
    handlers: {
        move: (state, userId: string, x: number, y: number, color: string) => {
            const map = safeParseMap(state.positions);
            map[userId] = { x, y, color, ts: Date.now() };
            return { ...state, positions: JSON.stringify(map) };
        },
        leave: (state, userId: string) => {
            const map = safeParseMap(state.positions);
            delete map[userId];
            return { ...state, positions: JSON.stringify(map) };
        },
    },
});

function safeParseMap(json: string): Record<string, { x: number; y: number; color: string; ts: number }> {
    try {
        return json ? JSON.parse(json) : {};
    } catch {
        return {};
    }
}
