/**
 * Deterministic hue (0-359) derived from any string — used by the UI
 * to color-code author names across the feed, leaderboard, and badges.
 * Same input always produces the same color, so 'alice' looks the
 * same shade of purple everywhere she shows up.
 */
export function authorHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}
