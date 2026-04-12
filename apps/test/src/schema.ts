import { table, id, integer, text, view, sum, count, channel } from '@syncengine/core';

// ── Tables ──────────────────────────────────────────────────────
export const clicks = table('clicks', {
    id: id(),
    label: text(),
    amount: integer(),
});

export const notes = table('notes', {
    id: id(),
    author: text(),
    body: text(),
});

// ── Views ───────────────────────────────────────────────────────
export const totalsView = view(clicks).aggregate([], {
    total: sum(clicks.amount),
    numClicks: count(),
});

export const notesList = view(notes).distinct();

// ── Channels (optional — tables auto-channel if omitted) ────────
// Explicit channels group tables onto a shared JetStream subject.
// Tables not listed in any channel get their own subject automatically.
export const mainChannel  = channel('main',  [clicks]);
export const notesChannel = channel('notes', [notes]);
