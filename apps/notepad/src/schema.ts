import { table, id, text, integer, view, count } from '@syncengine/core';

export const notes = table('notes', {
  id: id(),
  body: text(),
  author: text(),
  createdAt: integer(),
});

export const stats = view(notes).aggregate([], {
  totalNotes: count(),
});

export const recentNotes = view(notes)
  .topN(notes.createdAt, 20, 'desc');

// Per-message thumbs-up. Each row = one thumbs-up by one user on one note.
// Toggling a thumb inserts or removes a row; counts fall out of a view.
export const thumbs = table('thumbs', {
  id: id(),
  noteId: integer(),
  userId: text(),
});

// Every thumbs-up row (unaggregated). The UI derives per-note counts and
// "did I already thumb this?" by filtering this locally — it's a SQLite
// replica so the scan is cheap.
export const allThumbs = view(thumbs);

// Grouped aggregate — one row per author with their running note count.
// DBSP recomputes each group incrementally, so a million notes stay cheap.
export const notesByAuthor = view(notes).aggregate([notes.author], {
  count: count(),
});
