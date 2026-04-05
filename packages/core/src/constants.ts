// ── Shared constants ────────────────────────────────────────────────────────
// Single source of truth for magic numbers used across worker, store, and services.

/** Maximum undo stack depth before oldest entries are evicted */
export const UNDO_MAX_SIZE = 200;

/** Maximum nonces tracked for dedup; evicts oldest half when exceeded */
export const NONCE_DEDUP_MAX = 2000;

/** Maximum conflict log entries retained in the store */
export const CONFLICT_LOG_MAX = 100;

/** Peer ack reporting interval to Restate (ms) */
export const PEER_ACK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Peers not seen within this window are considered stale (ms) */
export const PEER_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Delay before NATS reconnect after disconnection (ms) */
export const NATS_RECONNECT_DELAY_MS = 3000;

/** Delay before NATS reconnect after connection failure (ms) */
export const NATS_RECONNECT_RETRY_MS = 5000;

/** Maximum authority backoff ceiling (ms) */
export const AUTHORITY_BACKOFF_MAX_MS = 30_000;

/** Initial authority backoff on first failure (ms) */
export const AUTHORITY_BACKOFF_INITIAL_MS = 1000;

/** Sync status progress emission interval (every N messages during replay) */
export const REPLAY_PROGRESS_INTERVAL = 50;

// ── HLC constants ───────────────────────────────────────────────────────────

/** Number of bits reserved for the counter in a packed HLC */
export const HLC_COUNTER_BITS = 16;

/** Maximum counter value before overflow (2^16) */
export const HLC_COUNTER_MAX = 2 ** HLC_COUNTER_BITS; // 65536
