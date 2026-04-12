import { table, id, integer, text, view, sum, count } from '@syncengine/core';

// ── Channel: main ───────────────────────────────────────────────
export const clicks = table('clicks', {
    id: id(),
    label: text(),
    amount: integer(),
});

export const totalsView = view(clicks).aggregate([], {
    total: sum(clicks.amount),
    numClicks: count(),
});

// ── Channel: notes ──────────────────────────────────────────────
export const notes = table('notes', {
    id: id(),
    author: text(),
    body: text(),
});

export const notesList = view(notes).distinct();

// ── Channels (separate JetStream subjects) ──────────────────────
// Each channel syncs independently — its own replay, catch-up, and
// consumer lifecycle. Tables must be assigned to exactly one channel.
export const channels = [
    { name: 'main',  tables: [clicks] },
    { name: 'notes', tables: [notes] },
] as const;
