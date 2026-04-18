import { store } from '@syncengine/client';
import { notes, thumbs, stats, recentNotes, allThumbs, notesByAuthor } from './schema';

/**
 * The reactive store. One instance per page load; every hook
 * (useStore / useEntity / useHeartbeat / useTopic) reads from here.
 */
export const db = store({
  tables: [notes, thumbs] as const,
  views: { stats, recentNotes, allThumbs, notesByAuthor },
});

export type DB = typeof db;
