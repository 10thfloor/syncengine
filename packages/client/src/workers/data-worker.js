import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { DbspEngine } from '@syncengine/dbsp';

// ── Shared lib imports (eliminates duplication) ─────────────────────────────
// HLC and migration logic live in @syncengine/core and are the single source
// of truth. The worker imports them instead of reimplementing.
import {
    hlcTick as _hlcTick,
    hlcMerge as _hlcMerge,
    hlcPack,
    hlcCompare,
    migrationStepToSQL,
    buildChannelRouting,
    resolvePublishSubjects,
    UNDO_MAX_SIZE,
    NONCE_DEDUP_MAX,
    PEER_ACK_INTERVAL_MS,
    NATS_RECONNECT_DELAY_MS,
    NATS_RECONNECT_RETRY_MS,
    AUTHORITY_BACKOFF_MAX_MS,
    AUTHORITY_BACKOFF_INITIAL_MS,
    REPLAY_PROGRESS_INTERVAL,
    HLC_COUNTER_MAX,
} from '@syncengine/core';

// ── Engine state ────────────────────────────────────────────────────────────

let db;
let dbsp;
const tablesMeta = {};
let initialized = false;
const pendingMessages = [];
let schemaTables = [];

// ── Undo stack ──────────────────────────────────────────────────────────────

const undoStack = [];

// ── CALM / Authority state ──────────────────────────────────────────────────

const authority = {
    viewMonotonicity: {},    // { viewName: 'monotonic' | 'non_monotonic' | 'unknown' }
    sub: null,               // NATS subscription for authority updates
    seqs: {},                // { viewName: lastSeenSeq }
    backoff: 0,              // current backoff ms
    backoffUntil: 0,         // timestamp — skip calls until this time
    restateUrl: 'http://localhost:8080',
};

// ── Nonce deduplication ─────────────────────────────────────────────────────

const CLIENT_ID = crypto.randomUUID();
const seenNonces = new Set();
let nonceSeq = 0;

function makeNonce() {
    return `${CLIENT_ID}-${++nonceSeq}`;
}

function dedup(nonce) {
    if (!nonce) return false;
    if (seenNonces.has(nonce)) return true;
    seenNonces.add(nonce);
    if (seenNonces.size > NONCE_DEDUP_MAX) {
        const arr = [...seenNonces];
        seenNonces.clear();
        for (let i = arr.length >> 1; i < arr.length; i++) seenNonces.add(arr[i]);
    }
    return false;
}

// ── HLC (Hybrid Logical Clock) ──────────────────────────────────────────────
// Mutable state wrapper around the pure hlc.ts functions.
// The worker needs mutable ts/count; the lib functions are pure.

let hlcTs = 0;
let hlcCount = 0;

function hlcTick() {
    const state = _hlcTick({ ts: hlcTs, count: hlcCount });
    hlcTs = state.ts;
    hlcCount = state.count;
    return state;
}

function hlcMerge(remote) {
    const state = _hlcMerge({ ts: hlcTs, count: hlcCount }, remote);
    hlcTs = state.ts;
    hlcCount = state.count;
    return state;
}

// ── Causal offline queue ────────────────────────────────────────────────────

const causalQueue = [];

function enqueueCausal(msg) {
    causalQueue.push(msg);
    causalQueue.sort((a, b) => hlcCompare(a._hlc, b._hlc));
}

function drainCausalQueue() {
    if (causalQueue.length === 0) return;
    console.log(`[causal] draining ${causalQueue.length} queued mutations`);
    const batch = causalQueue.splice(0);
    for (const msg of batch) natsPublish(msg);
}

// ── Cross-tab sync (BroadcastChannel) ───────────────────────────────────────

const channel = new BroadcastChannel('react-dbsp-sync');

channel.onmessage = (event) => {
    if (!initialized) return;
    const msg = event.data;
    if (msg._nonce && dedup(msg._nonce)) return;

    if (msg.type === 'RESET') {
        dbsp.reset();
        self.postMessage({ type: 'FULL_SYNC', snapshots: {} });
        return;
    }
    if (msg.type === 'DELTAS' && msg.viewUpdates) {
        emitViewUpdates(msg.viewUpdates);
    }
};

function broadcastDeltas(viewUpdates, nonce) {
    channel.postMessage({ type: 'DELTAS', viewUpdates, _nonce: nonce });
}

function broadcastReset(nonce) {
    channel.postMessage({ type: 'RESET', _nonce: nonce });
}

// ── NATS sync state ─────────────────────────────────────────────────────────

const nats = {
    conn: null,
    subs: [],              // one subscription per channel subject
    config: null,          // SyncConfig from store
    routing: null,         // ChannelRouting: { subjects, tableToSubject }
    outboundQueues: {},    // subject → pending messages (per-channel offline queue)
    peerAckTimer: null,
};

// ── Initial sync state machine ──────────────────────────────────────────────

const sync = {
    phase: 'idle',         // 'idle' | 'fetching_snapshot' | 'replaying' | 'live'
    lastProcessedSeqs: {}, // subject → last stream seq observed
    isReplaying: false,
    localMutationQueue: [],
};

function maxProcessedSeq() {
    const vals = Object.values(sync.lastProcessedSeqs);
    return vals.length > 0 ? Math.max(...vals) : 0;
}

// ── Status helpers ──────────────────────────────────────────────────────────

function setConnectionStatus(status) {
    self.postMessage({ type: 'CONNECTION_STATUS', status });
}

function emitSyncStatus(phase, messagesReplayed, extra = {}) {
    sync.phase = phase;
    self.postMessage({ type: 'SYNC_STATUS', phase, messagesReplayed, ...extra });
}

// ── Unified JetStream consumer (replay + live on one iterator) ─────────────
//
// One ordered pull consumer per channel subject, created with
// `opt_start_seq = lastProcessedSeqs[s] + 1` so it naturally picks up where
// the previous session left off. The SAME consumer serves both initial
// catchup and ongoing live delivery — no gap between "replay ends" and
// "live starts" because they are the same iterator.
//
// Phase transition: every JetStream message carries `raw.info.pending`, the
// number of messages still pending delivery AFTER this one. When a consumer
// sees `pending === 0` it has caught up with the stream as of right now.
// Once ALL consumers (one per subject) have reported caught-up at least
// once, a single global `finalizeReplay()` runs: flips `sync.isReplaying`
// to false, rebuilds DBSP from SQLite, and drains the local-mutation queue.
// After that, all consumers process messages as live (broadcasts fire,
// authority sends resume, cross-tab sync is on).
//
// Consumers run in parallel via independent async loops but coordinate
// on a shared `finalizeLatch` promise so concurrent messages landing on
// different subjects during finalize await it rather than racing DBSP.

async function finalizeReplay() {
    sync.isReplaying = false;

    // Replay may have applied RESET messages that wiped DBSP state
    // (including join indexes). Rebuild DBSP from SQLite so all views —
    // especially joins — have correct state before going live.
    dbsp.reset();
    hydrateFromSQLite(schemaTables);

    emitSyncStatus('live', maxProcessedSeq(), { snapshotLoaded: false });

    if (sync.localMutationQueue.length > 0) {
        console.log(`[sync] flushing ${sync.localMutationQueue.length} queued local mutations`);
        for (const msg of sync.localMutationQueue) await handleMessage(msg);
        sync.localMutationQueue = [];
    }
}

// Shared coordination state for the consumer loops. Reset on each connect.
const replayCoord = {
    caughtUp: new Set(),
    expected: 0,
    finalizeLatch: null,
};

function resetReplayCoord(expectedSubjects) {
    replayCoord.caughtUp = new Set();
    replayCoord.expected = expectedSubjects;
    replayCoord.finalizeLatch = null;
    replayCoord.finalizeFailed = false;
}

async function markConsumerCaughtUp(subject) {
    if (replayCoord.caughtUp.has(subject)) return;
    replayCoord.caughtUp.add(subject);
    console.log(`[sync] caught up on ${subject} (${replayCoord.caughtUp.size}/${replayCoord.expected})`);

    if (replayCoord.caughtUp.size === replayCoord.expected && !replayCoord.finalizeLatch) {
        // Kick off finalize once. Other consumer loops that encounter
        // `finalizeLatch` at the top of their iteration will await it, so
        // no message is processed concurrently with DBSP rebuild.
        replayCoord.finalizeLatch = finalizeReplay().catch((e) => {
            console.error('[sync] finalize failed:', e);
            // Mark the failure so the post-await flush path below can
            // skip the outbound queue drain — which would otherwise run
            // against a half-reset DBSP (reset() succeeded, hydrate()
            // threw) and emit corrupt deltas to the UI.
            replayCoord.finalizeFailed = true;
            // Unblock consumers even on failure — otherwise they hang forever.
            sync.isReplaying = false;
        });
        await replayCoord.finalizeLatch;

        if (replayCoord.finalizeFailed) {
            // DBSP may be in an inconsistent state (finalize threw between
            // reset and hydrate). The only safe recovery is a full
            // reconnect — which tears down the consumers, wipes
            // replayCoord, and re-runs the replay phase from scratch.
            setConnectionStatus('disconnected');
            if (nats.conn && !nats.conn.isClosed()) {
                try { await nats.conn.close(); } catch { /* ignore */ }
            }
            return;
        }

        setConnectionStatus('connected');

        // Flush per-channel offline queues: anything that was queued while
        // we were offline now has a live connection to publish through.
        if (nats.conn && !nats.conn.isClosed()) {
            const codec = replayCoord.codec;
            for (const s of nats.routing.subjects) {
                const queue = nats.outboundQueues[s] || [];
                for (const msg of queue) {
                    nats.conn.publish(s, codec.encode(msg));
                }
                nats.outboundQueues[s] = [];
            }
            drainCausalQueue();
        }
    }
}

/**
 * Process messages from a single consumer's iterator. Runs forever until
 * the iterator closes (disconnect) or is explicitly stopped. Handles both
 * the initial catch-up phase and ongoing live delivery — the `_isReplay`
 * flag is derived from the global `sync.isReplaying` at processing time.
 */
async function processConsumer(codec, source) {
    const { subject, consumer, messages } = source;

    // Probe num_pending upfront so subjects that start fully caught up
    // (empty stream, or lastProcessedSeqs already at the tip) still fire
    // their "caught up" signal — the for-await below would otherwise block
    // forever waiting for a first message that never comes.
    //
    // If the probe throws (network hiccup, transient broker error), we
    // must still mark the subject caught up. Otherwise `caughtUp.size`
    // never reaches `expected`, finalize never runs, `sync.isReplaying`
    // stays true, and every local mutation silently queues into
    // `sync.localMutationQueue` forever with no user-visible error.
    // Assuming caught-up on probe failure is the safer degraded mode:
    // the for-await will still deliver any messages that actually arrive.
    try {
        const info = await consumer.info();
        if (info.num_pending === 0) {
            await markConsumerCaughtUp(subject);
        } else {
            console.log(`[sync] replaying ${info.num_pending} pending from ${subject}`);
            emitSyncStatus('replaying', 0, { totalMessages: info.num_pending });
            setConnectionStatus('syncing');
        }
    } catch (e) {
        console.warn(`[sync] consumer.info() failed for ${subject}, assuming caught up:`, e?.message || e);
        await markConsumerCaughtUp(subject);
    }

    let processed = 0;

    try {
        for await (const raw of messages) {
            if (!initialized) continue;

            // Wait for any in-flight finalize to complete before processing
            // more messages. Prevents the race where another consumer has
            // triggered finalize (DBSP reset + hydrate) and this loop would
            // otherwise write to DBSP concurrently.
            if (replayCoord.finalizeLatch) {
                await replayCoord.finalizeLatch;
            }

            let msg;
            try { msg = codec.decode(raw.data); } catch {
                raw.ack();
                if (raw.info?.pending === 0) await markConsumerCaughtUp(subject);
                continue;
            }

            // Skip our own outbound messages echoed back by the stream.
            if (msg._clientId === CLIENT_ID) {
                raw.ack();
                sync.lastProcessedSeqs[subject] = raw.seq;
                if (raw.info?.pending === 0) await markConsumerCaughtUp(subject);
                continue;
            }

            // Nonce dedup — protects against any residual cross-path overlap
            // (should be impossible with the unified consumer, but cheap).
            if (msg._nonce && dedup(msg._nonce)) {
                raw.ack();
                sync.lastProcessedSeqs[subject] = raw.seq;
                if (raw.info?.pending === 0) await markConsumerCaughtUp(subject);
                continue;
            }

            // `sync.isReplaying` is the single source of truth for whether
            // a message is in the catchup phase (queue, no broadcast) or
            // live phase (broadcast + authority). It stays true until
            // `finalizeReplay()` completes, at which point every subsequent
            // message on every consumer flips to live behavior in lockstep.
            //
            // INVARIANT: `handleInsert` and `handleDelete` below MUST remain
            // synchronous (no internal awaits). Their body runs atomically
            // within a single microtask, which is what prevents a race
            // where another consumer's `markConsumerCaughtUp` triggers
            // finalize (dbsp.reset + hydrateFromSQLite) while this one
            // has yielded mid-DBSP-mutation. If a future change needs to
            // await inside handleInsert/handleDelete, the coordination
            // model here must be revisited (e.g. by holding `finalizeLatch`
            // open around the DBSP write itself).
            const isReplay = sync.isReplaying;

            if (msg.type === 'SCHEMA_MIGRATION' && msg.toVersion && msg.migrations) {
                handleSchemaMigrationNotification(msg);
            } else if (msg.type === 'INSERT' && msg.table && msg.record) {
                await handleMessage({
                    type: 'INSERT', table: msg.table, record: msg.record,
                    _noUndo: true, _fromNats: true, _isReplay: isReplay,
                    _nonce: msg._nonce, _hlc: msg._hlc,
                });
            } else if (msg.type === 'DELETE' && msg.table && msg.id !== undefined) {
                await handleMessage({
                    type: 'DELETE', table: msg.table, id: msg.id,
                    _fromNats: true, _isReplay: isReplay,
                    _nonce: msg._nonce, _hlc: msg._hlc,
                });
            } else if (msg.type === 'RESET') {
                // RESET wipes SQLite + DBSP unconditionally. The live-only
                // side effects (undo wipe, FULL_SYNC post, cross-tab broadcast)
                // only fire once we are past the replay phase.
                for (const t of schemaTables) db.exec(`DELETE FROM ${t.name}`);
                dbsp.reset();
                if (!isReplay) {
                    undoStack.length = 0;
                    self.postMessage({ type: 'UNDO_SIZE', size: 0 });
                    self.postMessage({ type: 'FULL_SYNC', snapshots: {} });
                    broadcastReset(msg._nonce);
                }
            }

            raw.ack();
            processed++;
            sync.lastProcessedSeqs[subject] = raw.seq;

            if (isReplay && processed % REPLAY_PROGRESS_INTERVAL === 0) {
                emitSyncStatus('replaying', processed);
            }

            // Primary replay → live transition signal: when the broker
            // tells us the consumer has nothing left pending, this
            // consumer has caught up with the stream's tail.
            if (raw.info?.pending === 0) {
                await markConsumerCaughtUp(subject);
            }
        }
    } catch (e) {
        // Natural termination (disconnect, stop, network error).
        console.log(`[sync] consumer loop for ${subject} ended:`, e?.message || 'closed');
    }
}

// ── NATS connection ─────────────────────────────────────────────────────────

async function connectNats() {
    if (!nats.config) return;
    if (!nats.routing) {
        console.warn('[nats] cannot connect: channel routing not initialized');
        return;
    }

    const natsUrl = nats.config.natsUrl || 'ws://localhost:9222';
    const channelSubjects = nats.routing.subjects;

    setConnectionStatus('connecting');

    try {
        const { connect, JSONCodec } = await import('nats.ws');
        const codec = JSONCodec();

        const connectOpts = { servers: natsUrl };
        if (nats.config.authToken) connectOpts.token = nats.config.authToken;
        nats.conn = await connect(connectOpts);
        console.log(`[nats] connected to ${natsUrl}`);

        // Initialize replay phase — consumers will flip this to false once
        // they've all reported caught-up via `markConsumerCaughtUp`.
        sync.isReplaying = true;
        resetReplayCoord(channelSubjects.length);
        replayCoord.codec = codec;
        authority.backoff = 0;
        authority.backoffUntil = 0;

        // Create one ordered pull consumer per channel subject, starting at
        // the high-water mark recorded from the previous session (or from
        // the beginning on first connect). Each consumer serves both the
        // historical catchup AND ongoing live delivery — there is no
        // separate "subscribe live" step.
        const js = nats.conn.jetstream();
        const streamName = `WS_${nats.config.workspaceId.replace(/-/g, '_')}`;
        const sources = [];
        for (const s of channelSubjects) {
            const lastSeq = sync.lastProcessedSeqs[s] || 0;
            const consumerOpts = lastSeq > 0
                ? { filterSubjects: [s], deliver_policy: 'by_start_sequence', opt_start_seq: lastSeq + 1 }
                : { filterSubjects: [s] };
            const consumer = await js.consumers.get(streamName, consumerOpts);
            const messages = await consumer.consume();
            sources.push({ subject: s, consumer, messages });
        }

        // Start all consumer loops in parallel. Each loop is long-lived and
        // runs until disconnect. The first consumer loop whose `markConsumerCaughtUp`
        // brings `caughtUp.size` up to `expected` is responsible for kicking
        // off the single global `finalizeReplay()`.
        //
        // Fire-and-forget — internal try/catch in processConsumer covers
        // the for-await. The `.catch()` here is a defensive trap for any
        // synchronous throw between function entry and the first try block
        // that would otherwise become an unhandled rejection in the Worker.
        nats.subs = sources;
        for (const source of sources) {
            processConsumer(codec, source).catch((err) => {
                console.error(`[sync] processConsumer(${source.subject}) unhandled:`, err);
            });
        }

        // Other per-connection subscriptions (not the replay path).
        await subscribeAuthority(codec);
        subscribeGC(codec);
        startPeerAckTimer();
        watchDisconnect();

    } catch (e) {
        const errMsg = e.message || String(e);
        console.warn('[nats] connection failed:', errMsg);
        if (errMsg.includes('authorization') || errMsg.includes('authentication') || errMsg.includes('permission')) {
            setConnectionStatus('auth_failed');
        } else {
            setConnectionStatus('disconnected');
        }
        nats.conn = null;
        setTimeout(() => connectNats(), NATS_RECONNECT_RETRY_MS);
    }
}

// ── GC subscription ─────────────────────────────────────────────────────────

function subscribeGC(codec) {
    const gcSubject = `ws.${nats.config.workspaceId}.gc`;
    const gcSub = nats.conn.subscribe(gcSubject);
    (async () => {
        for await (const raw of gcSub) {
            let msg;
            try { msg = codec.decode(raw.data); } catch { continue; }
            if (msg.type === 'GC_COMPLETE' && msg.gcWatermark) {
                console.log(`[gc] received GC_COMPLETE watermark=${msg.gcWatermark}`);
                // GC watermark is stream-global; advance all channels past it
                // so future replays skip GC'd messages regardless of channel.
                if (nats.routing) {
                    for (const s of nats.routing.subjects) {
                        if ((sync.lastProcessedSeqs[s] || 0) < msg.gcWatermark) {
                            sync.lastProcessedSeqs[s] = msg.gcWatermark;
                        }
                    }
                }
            }
        }
    })();
}

// ── Peer ack timer ──────────────────────────────────────────────────────────

function startPeerAckTimer() {
    if (nats.peerAckTimer) clearInterval(nats.peerAckTimer);
    nats.peerAckTimer = setInterval(() => {
        if (!nats.config || !nats.conn || nats.conn.isClosed()) return;
        const url = `${authority.restateUrl}/workspace/${nats.config.workspaceId}/reportPeerSeq`;
        const headers = { 'Content-Type': 'application/json' };
        if (nats.config.authToken) headers.Authorization = `Bearer ${nats.config.authToken}`;
        fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                clientId: CLIENT_ID,
                userId: nats.config.userId,
                lastSeq: maxProcessedSeq(),
            }),
        }).catch(e => console.warn('[gc] peer ack failed:', e.message || e));
    }, PEER_ACK_INTERVAL_MS);
}

// ── Disconnect watcher ──────────────────────────────────────────────────────

async function watchDisconnect() {
    const err = await nats.conn.closed();
    console.log('[nats] connection closed', err || '');
    setConnectionStatus('disconnected');

    // Best-effort cleanup of the per-subject ordered pull consumers. Each
    // consumer has a 5-minute `inactive_threshold` on the NATS server, so
    // leaking them on disconnect is survivable but wasteful. Across many
    // reconnects it can exhaust the stream's `max_consumers`. We stop the
    // iterator locally and call delete() on the server-side consumer.
    const sources = nats.subs || [];
    nats.subs = [];
    for (const source of sources) {
        try { source.messages?.stop(); } catch { /* ignore */ }
        try { await source.consumer?.delete(); } catch { /* ignore */ }
    }

    nats.conn = null;
    authority.sub = null;
    if (nats.peerAckTimer) { clearInterval(nats.peerAckTimer); nats.peerAckTimer = null; }
    setTimeout(() => connectNats(), NATS_RECONNECT_DELAY_MS);
}

// ── Authority routing (CALM non-monotonic views) ────────────────────────────

function sendToAuthority(viewName, deltas) {
    if (!nats.config) return;
    if (!nats.conn || nats.conn.isClosed()) return;
    if (Date.now() < authority.backoffUntil) return;

    const url = `${authority.restateUrl}/workspace/${nats.config.workspaceId}/authority`;
    const headers = { 'Content-Type': 'application/json' };
    if (nats.config.authToken) headers.Authorization = `Bearer ${nats.config.authToken}`;

    fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ viewName, deltas }),
    }).then(res => {
        if (!res.ok) {
            applyAuthorityBackoff(`HTTP ${res.status} for ${viewName}`);
            return;
        }
        authority.backoff = 0;
        authority.backoffUntil = 0;
        return res.json();
    }).then(result => {
        if (result) console.log(`[authority] ${viewName} seq=${result.seq}`);
    }).catch(err => {
        applyAuthorityBackoff(err.message || err);
    });
}

function applyAuthorityBackoff(reason) {
    authority.backoff = Math.min((authority.backoff || AUTHORITY_BACKOFF_INITIAL_MS) * 2, AUTHORITY_BACKOFF_MAX_MS);
    authority.backoffUntil = Date.now() + authority.backoff;
    console.warn(`[authority] backing off ${authority.backoff}ms: ${reason}`);
}

async function subscribeAuthority(codec) {
    if (!nats.conn || !nats.config) return;

    const nonMonViews = Object.entries(authority.viewMonotonicity)
        .filter(([, m]) => m === 'non_monotonic')
        .map(([name]) => name);

    if (nonMonViews.length === 0) return;

    const subject = `ws.${nats.config.workspaceId}.authority.>`;
    authority.sub = nats.conn.subscribe(subject);
    console.log(`[authority] subscribed to ${subject} for ${nonMonViews.length} non-monotonic views`);

    (async () => {
        for await (const raw of authority.sub) {
            if (!initialized) continue;
            let msg;
            try { msg = codec.decode(raw.data); } catch { continue; }
            if (msg.type !== 'AUTHORITY_UPDATE') continue;

            const { viewName, seq, deltas } = msg;
            const lastSeq = authority.seqs[viewName] || 0;
            if (seq <= lastSeq) continue;
            authority.seqs[viewName] = seq;

            console.log(`[authority] applying seq=${seq} for ${viewName} (${deltas.length} deltas)`);
            self.postMessage({
                type: 'VIEW_UPDATE',
                viewName,
                deltas: deltas.map(d => ({ record: d.record, weight: d.weight })),
            });
        }
    })();
}

// ── NATS publish ────────────────────────────────────────────────────────────

function natsPublish(msg) {
    if (!nats.config || !nats.routing) return;

    msg._clientId = CLIENT_ID;
    if (nats.config.userId) msg._userId = nats.config.userId;

    // Resolve target subjects: table-scoped → one subject, workspace-wide → all.
    const subjects = resolvePublishSubjects(nats.routing, msg);
    if (subjects.length === 0) {
        console.warn(`[nats] dropping message for unmapped table: ${msg.table}`);
        return;
    }

    if (nats.conn && !nats.conn.isClosed()) {
        import('nats.ws').then(({ JSONCodec }) => {
            const codec = JSONCodec();
            for (const s of subjects) {
                nats.conn.publish(s, codec.encode(msg));
            }
        });
    } else if (msg._hlc) {
        enqueueCausal(msg);
    } else {
        for (const s of subjects) {
            if (!nats.outboundQueues[s]) nats.outboundQueues[s] = [];
            nats.outboundQueues[s].push(msg);
        }
    }
}

// ── Schema migrations ───────────────────────────────────────────────────────

function runMigrations(targetVersion, migrations) {
    db.exec("CREATE TABLE IF NOT EXISTS _dbsp_meta (key TEXT PRIMARY KEY, value TEXT)");

    const rows = db.exec("SELECT value FROM _dbsp_meta WHERE key = 'schema_version'", { rowMode: 'array' });
    const currentVersion = rows.length > 0 ? Number.parseInt(rows[0][0], 10) : 0;

    if (currentVersion >= targetVersion) {
        console.log(`[migrations] schema at v${currentVersion}, target v${targetVersion} — no migrations needed`);
        return currentVersion;
    }

    console.log(`[migrations] migrating v${currentVersion} → v${targetVersion}`);
    self.postMessage({ type: 'MIGRATION_STATUS', fromVersion: currentVersion, toVersion: targetVersion, status: 'running', stepsApplied: 0 });

    const toApply = (migrations || [])
        .filter(m => m.version > currentVersion && m.version <= targetVersion)
        .sort((a, b) => a.version - b.version);

    let stepsApplied = 0;

    for (const migration of toApply) {
        for (const step of migration.steps) {
            try {
                const sql = migrationStepToSQL(step);
                console.log(`[migrations] v${migration.version}: ${sql}`);
                db.exec(sql);
                stepsApplied++;
            } catch (e) {
                console.error(`[migrations] failed at v${migration.version}:`, e.message || e);
                const lastGoodVersion = migration.version - 1;
                if (lastGoodVersion > currentVersion) {
                    db.exec(`INSERT OR REPLACE INTO _dbsp_meta (key, value) VALUES ('schema_version', '${lastGoodVersion}')`);
                }
                self.postMessage({
                    type: 'MIGRATION_STATUS', fromVersion: currentVersion, toVersion: targetVersion,
                    status: 'failed', stepsApplied, error: e.message || String(e), failedAtVersion: migration.version,
                });
                return lastGoodVersion > currentVersion ? lastGoodVersion : currentVersion;
            }
        }
    }

    db.exec(`INSERT OR REPLACE INTO _dbsp_meta (key, value) VALUES ('schema_version', '${targetVersion}')`);
    self.postMessage({ type: 'MIGRATION_STATUS', fromVersion: currentVersion, toVersion: targetVersion, status: 'complete', stepsApplied });
    console.log(`[migrations] complete: v${currentVersion} → v${targetVersion} (${stepsApplied} steps)`);
    return targetVersion;
}

function handleSchemaMigrationNotification(msg) {
    console.log(`[nats] received schema migration notification: v${msg.fromVersion} → v${msg.toVersion}`);
    runMigrations(msg.toVersion, msg.migrations);

    for (const t of schemaTables) {
        const pragma = db.exec(`PRAGMA table_info(${t.name})`, { rowMode: 'object' });
        if (pragma.length > 0) {
            const columns = pragma.map(col => col.name);
            const placeholders = columns.map(() => '?').join(', ');
            tablesMeta[t.name] = {
                insertSql: `INSERT OR REPLACE INTO ${t.name} (${columns.join(', ')}) VALUES (${placeholders})`,
                columns,
            };
        }
    }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function stepEmitBroadcast(deltas, nonce) {
    if (deltas.length === 0) return;
    const result = dbsp.step(deltas);

    const viewUpdates = result.views || result;
    const conflicts = result.conflicts || [];

    emitViewUpdates(viewUpdates);

    const normalized = {};
    for (const [viewName, viewDeltas] of viewUpdates instanceof Map ? viewUpdates.entries() : Object.entries(viewUpdates)) {
        normalized[viewName] = viewDeltas.map(d => deepToObject(d));
    }
    if (Object.keys(normalized).length > 0 && !sync.isReplaying) broadcastDeltas(normalized, nonce);

    if (conflicts.length > 0) {
        self.postMessage({ type: 'CONFLICTS', conflicts });
    }

    // Route non-monotonic view deltas to authority (CALM)
    if (nats.config && !sync.isReplaying) {
        for (const [viewName, viewDeltas] of Object.entries(normalized)) {
            if (authority.viewMonotonicity[viewName] === 'non_monotonic' && viewDeltas.length > 0) {
                sendToAuthority(viewName, viewDeltas);
            }
        }
    }
}

function deleteWithFullRetraction(tableName, id, nonce) {
    const meta = tablesMeta[tableName];
    if (!meta) return;
    const idCol = meta.columns[0];

    const rows = db.exec(`SELECT * FROM ${tableName} WHERE ${idCol} = ?`, { bind: [id], rowMode: 'object' });
    db.exec(`DELETE FROM ${tableName} WHERE ${idCol} = ?`, { bind: [id] });

    if (rows.length > 0) {
        stepEmitBroadcast([{ source: tableName, record: rows[0], weight: -1 }], nonce);
    }
}

// ── Message handlers (broken out from monolithic handleMessage) ─────────────

async function handleInit(data) {
    const { schema } = data;

    // 1. DBSP Engine
    dbsp = new DbspEngine(
        schema.views.map(v => ({
            name: v.name,
            source_table: v.source_table || v.tableName,
            id_key: v.id_key,
            pipeline: v.pipeline,
        }))
    );

    // 2. SQLite with OPFS persistence
    const sqlite3 = await sqlite3InitModule();
    const dbPath = '/react-dbsp.sqlite3';

    if (sqlite3.oo1.OpfsDb) {
        db = new sqlite3.oo1.OpfsDb(dbPath);
        console.log('SQLite initialized with OPFS');
    } else {
        db = new sqlite3.oo1.DB(dbPath, 'ct');
        console.log('SQLite initialized in-memory (OPFS unavailable)');
    }

    // 3. Create tables
    for (const t of schema.tables) {
        db.exec(t.sql);
        tablesMeta[t.name] = { insertSql: t.insertSql, columns: t.columns };
    }

    // 3b. Run schema migrations
    const targetVersion = data.schemaVersion || 1;
    const migrations = data.migrations || [];
    if (migrations.length > 0) {
        const newVersion = runMigrations(targetVersion, migrations);
        if (newVersion > 1) {
            for (const t of schema.tables) {
                tablesMeta[t.name] = { insertSql: t.insertSql, columns: t.columns };
            }
        }
    } else {
        db.exec("CREATE TABLE IF NOT EXISTS _dbsp_meta (key TEXT PRIMARY KEY, value TEXT)");
        db.exec(`INSERT OR IGNORE INTO _dbsp_meta (key, value) VALUES ('schema_version', '${targetVersion}')`);
    }

    // 4. Register merge configs (CRDV)
    if (schema.mergeConfigs) {
        for (const mc of schema.mergeConfigs) {
            dbsp.register_merge(mc.table, { fields: mc.fields });
            console.log(`[merge] registered ${Object.keys(mc.fields).length} field strategies for ${mc.table}`);
        }
    }

    // 5. View monotonicity (CALM)
    authority.viewMonotonicity = {};
    for (const v of schema.views) {
        authority.viewMonotonicity[v.name] = v.monotonicity || 'unknown';
    }

    // 6. (CDC removed — handleInsert/deleteWithFullRetraction emit deltas
    //    directly, capturing old-row state via SELECT before each write.
    //    The SQLite update_hook was unreliable for INSERT OR REPLACE.)

    // 7. Hydrate from persisted data
    schemaTables = schema.tables;
    hydrateFromSQLite(schemaTables);

    self.postMessage({ type: 'READY' });

    // 8. Connect to NATS
    if (data.sync) {
        nats.config = data.sync;
        if (data.sync.restateUrl) authority.restateUrl = data.sync.restateUrl;

        // Build channel routing: legacy mode (no channels) uses one default
        // subject; multi-channel mode maps tables to per-channel subjects.
        nats.routing = buildChannelRouting(data.sync, schema.tables.map(t => t.name));
        for (const s of nats.routing.subjects) {
            if (!nats.outboundQueues[s]) nats.outboundQueues[s] = [];
        }

        connectNats();
    }

    // Flush queued messages
    initialized = true;
    for (const msg of pendingMessages) await handleMessage(msg);
    pendingMessages.length = 0;
}

function handleInsert(data) {
    const { table: tableName, record } = data;
    const meta = tablesMeta[tableName];
    if (!meta) {
        console.warn('[worker] Unknown table:', tableName);
        return;
    }

    const nonce = data._fromNats ? data._nonce : makeNonce();
    const idCol = meta.columns[0];
    const idVal = record[idCol];

    // Capture the OLD row BEFORE the write, so we can emit a proper retraction
    // delta. SQLite's update_hook is unreliable here: depending on version, it
    // may fire UPDATE (which we'd treat as +1 with no compensating -1) or
    // DELETE+INSERT where both lookups happen AFTER the write (so the -1 ends
    // up referencing the NEW row data). Either way, the right side of joins
    // ends up with duplicated entries because right_index has no id-based
    // deduplication on insertion. Capturing the old row here lets us emit a
    // correct (-1 OLD, +1 NEW) pair that DBSP can apply incrementally.
    const oldRows = db.exec(
        `SELECT * FROM ${tableName} WHERE ${idCol} = ?`,
        { bind: [idVal], rowMode: 'object' }
    );
    const oldRow = oldRows.length > 0 ? oldRows[0] : null;

    // HLC: for remote (replay/NATS) inserts, merge with the source clock; for
    // local writes, tick once for the retraction and again for the insertion
    // so the +1 has a strictly greater packed HLC than the -1. This bypasses
    // the anti-resurrection check (`insert_hlc <= tombstone_hlc → skip`)
    // which would otherwise drop the +1 when both deltas have HLC 0.
    let hlcRetract = null;
    let hlcInsert;
    if (data._fromNats && data._hlc) {
        hlcInsert = hlcMerge(data._hlc);
        hlcRetract = hlcInsert; // remote source defines a single logical time
    } else {
        if (oldRow) hlcRetract = hlcTick();
        hlcInsert = hlcTick();
    }

    // Write SQLite. We don't rely on update_hook events — we emit the deltas
    // ourselves below using the captured old row + the supplied new record.
    const values = meta.columns.map(col => record[col] ?? null);
    db.exec(meta.insertSql, { bind: values });

    // Build deltas: retract old (if existed), then insert new.
    const newRow = { ...record };
    const deltas = [];
    if (oldRow) {
        deltas.push({ source: tableName, record: oldRow, weight: -1, hlc: hlcRetract });
    }
    deltas.push({ source: tableName, record: newRow, weight: 1, hlc: hlcInsert });

    if (!data._noUndo) {
        undoStack.push({ table: tableName, id: idVal });
        if (undoStack.length > UNDO_MAX_SIZE) undoStack.shift();
        self.postMessage({ type: 'UNDO_SIZE', size: undoStack.length });
    }

    if (!data._fromNats && !data._localOnly) {
        natsPublish({ type: 'INSERT', table: tableName, record, _nonce: nonce, _hlc: hlcInsert });
    }

    stepEmitBroadcast(deltas, nonce);
}

function handleDelete(data) {
    const { table: tableName, id: deleteId } = data;
    const nonce = data._fromNats ? data._nonce : makeNonce();
    const hlc = (data._fromNats && data._hlc) ? hlcMerge(data._hlc) : hlcTick();

    if (!data._fromNats) {
        natsPublish({ type: 'DELETE', table: tableName, id: deleteId, _nonce: nonce, _hlc: hlc });
    }
    deleteWithFullRetraction(tableName, deleteId, nonce);
}

function handleUndo() {
    if (undoStack.length === 0) return;
    const { table: undoTable, id: undoId } = undoStack.pop();
    const nonce = makeNonce();
    const hlc = hlcTick();
    natsPublish({ type: 'DELETE', table: undoTable, id: undoId, _nonce: nonce, _hlc: hlc });
    deleteWithFullRetraction(undoTable, undoId, nonce);
    self.postMessage({ type: 'UNDO_SIZE', size: undoStack.length });
}

function handleReset() {
    const nonce = makeNonce();
    const hlc = hlcTick();
    for (const t of schemaTables) db.exec(`DELETE FROM ${t.name}`);
    dbsp.reset();
    undoStack.length = 0;
    causalQueue.length = 0;
    for (const s of Object.keys(nats.outboundQueues)) nats.outboundQueues[s] = [];

    // Break out of replay if stuck — discard any queued local mutations
    sync.isReplaying = false;
    sync.localMutationQueue = [];

    self.postMessage({ type: 'UNDO_SIZE', size: 0 });
    self.postMessage({ type: 'FULL_SYNC', snapshots: {} });
    broadcastReset(nonce);
    natsPublish({ type: 'RESET', _nonce: nonce, _hlc: hlc });
}


// ── Message router ──────────────────────────────────────────────────────────

self.onmessage = async (event) => {
    try {
        if (!initialized && event.data.type !== 'INIT') {
            pendingMessages.push(event.data);
            return;
        }
        await handleMessage(event.data);
    } catch (err) {
        console.error('[worker] FATAL:', err);
    }
};

// Signal to the main thread that the module has loaded and onmessage is set.
self.postMessage({ type: 'WORKER_LOADED' });

async function handleMessage(data) {
    // Queue local mutations during replay — but always allow RESET through
    // so the user can break out of a stuck or long replay.
    if (sync.isReplaying && data.type !== 'INIT' && data.type !== 'RESET' && !data._fromNats && !data._isReplay) {
        sync.localMutationQueue.push(data);
        return;
    }

    switch (data.type) {
        case 'INIT':   return handleInit(data);
        case 'INSERT': return handleInsert(data);
        case 'DELETE': return handleDelete(data);
        case 'UNDO':   return handleUndo();
        case 'RESET':  return handleReset();
    }
}

function emitViewUpdates(viewUpdates) {
    for (const [viewName, viewDeltas] of viewUpdates instanceof Map ? viewUpdates.entries() : Object.entries(viewUpdates)) {
        const normalized = viewDeltas.map(d => deepToObject(d));
        if (normalized.length > 0) {
            self.postMessage({ type: 'VIEW_UPDATE', viewName, deltas: normalized });
        }
    }
}

function hydrateFromSQLite(tables) {
    const deltas = [];
    for (const t of tables) {
        const rows = db.exec(`SELECT * FROM ${t.name}`, { rowMode: 'object' });
        for (const row of rows) deltas.push({ source: t.name, record: row, weight: 1 });
    }
    if (deltas.length === 0) return;

    const result = dbsp.step(deltas);
    const viewUpdates = result.views || result;
    emitViewUpdates(viewUpdates);
}

function deepToObject(val) {
    if (val instanceof Map) {
        const obj = {};
        for (const [k, v] of val) obj[k] = deepToObject(v);
        return obj;
    }
    if (Array.isArray(val)) return val.map(deepToObject);
    if (val !== null && typeof val === 'object') {
        const obj = {};
        for (const [k, v] of Object.entries(val)) obj[k] = deepToObject(v);
        return obj;
    }
    return val;
}
