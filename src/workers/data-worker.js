import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import initDBSP, { DbspEngine } from 'dbsp-engine';

// ── Shared lib imports (eliminates duplication) ─────────────────────────────
// HLC and migration logic live in src/lib/ and are the single source of truth.
// The worker imports them instead of reimplementing.
import { hlcTick as _hlcTick, hlcMerge as _hlcMerge, hlcPack, hlcCompare } from '../lib/hlc';
import { migrationStepToSQL } from '../lib/migrations';
import {
    UNDO_MAX_SIZE, NONCE_DEDUP_MAX, PEER_ACK_INTERVAL_MS,
    NATS_RECONNECT_DELAY_MS, NATS_RECONNECT_RETRY_MS,
    AUTHORITY_BACKOFF_MAX_MS, AUTHORITY_BACKOFF_INITIAL_MS,
    REPLAY_PROGRESS_INTERVAL, HLC_COUNTER_MAX,
} from '../lib/constants';

// ── Engine state ────────────────────────────────────────────────────────────

let db;
let dbsp;
let tablesMeta = {};
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

// ── CDC queue ───────────────────────────────────────────────────────────────

const cdcQueue = [];

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
    sub: null,
    config: null,          // SyncConfig from store
    outboundQueue: [],
    peerAckTimer: null,
};

// ── Initial sync state machine ──────────────────────────────────────────────

const sync = {
    phase: 'idle',         // 'idle' | 'fetching_snapshot' | 'replaying' | 'live'
    lastProcessedSeq: 0,
    isReplaying: false,
    localMutationQueue: [],
};

// ── Status helpers ──────────────────────────────────────────────────────────

function setConnectionStatus(status) {
    self.postMessage({ type: 'CONNECTION_STATUS', status });
}

function emitSyncStatus(phase, messagesReplayed, extra = {}) {
    sync.phase = phase;
    self.postMessage({ type: 'SYNC_STATUS', phase, messagesReplayed, ...extra });
}

// ── JetStream replay ────────────────────────────────────────────────────────

async function replayFromJetStream(codec, subject) {
    sync.isReplaying = true;

    try {
        const streamName = `WS_${nats.config.workspaceId.replace(/-/g, '_')}`;
        const js = nats.conn.jetstream();
        const jsm = await nats.conn.jetstreamManager();

        let streamInfo;
        try {
            streamInfo = await jsm.streams.info(streamName);
        } catch {
            console.log('[sync] no stream found, skipping replay');
            sync.isReplaying = false;
            emitSyncStatus('live', 0);
            return;
        }

        const msgCount = Number(streamInfo.state.messages);
        if (msgCount === 0) {
            console.log('[sync] stream empty, skipping replay');
            sync.isReplaying = false;
            emitSyncStatus('live', 0);
            return;
        }

        console.log(`[sync] replaying ${msgCount} messages from JetStream`);
        emitSyncStatus('replaying', 0, { totalMessages: msgCount });
        setConnectionStatus('syncing');

        const consumerOpts = sync.lastProcessedSeq > 0
            ? { filterSubjects: [subject], deliver_policy: 'by_start_sequence', opt_start_seq: sync.lastProcessedSeq + 1 }
            : { filterSubjects: [subject] };

        const consumer = await js.consumers.get(streamName, consumerOpts);
        const messages = await consumer.consume();
        let replayed = 0;

        for await (const raw of messages) {
            let msg;
            try { msg = codec.decode(raw.data); } catch { raw.ack(); replayed++; continue; }

            if (msg._clientId === CLIENT_ID) { raw.ack(); replayed++; sync.lastProcessedSeq = raw.seq; continue; }

            if (msg.type === 'INSERT' && msg.table && msg.record) {
                await handleMessage({
                    type: 'INSERT', table: msg.table, record: msg.record,
                    _noUndo: true, _fromNats: true, _isReplay: true,
                    _nonce: msg._nonce, _hlc: msg._hlc,
                });
            } else if (msg.type === 'DELETE' && msg.table && msg.id !== undefined) {
                await handleMessage({
                    type: 'DELETE', table: msg.table, id: msg.id,
                    _fromNats: true, _isReplay: true,
                    _nonce: msg._nonce, _hlc: msg._hlc,
                });
            } else if (msg.type === 'RESET') {
                for (const t of schemaTables) db.exec(`DELETE FROM ${t.name}`);
                dbsp.reset();
            }

            raw.ack();
            replayed++;
            sync.lastProcessedSeq = raw.seq;

            if (replayed % REPLAY_PROGRESS_INTERVAL === 0) {
                emitSyncStatus('replaying', replayed, { totalMessages: msgCount });
            }
            if (replayed >= msgCount) { messages.stop(); break; }
        }

        console.log(`[sync] replay complete: ${replayed} messages`);
    } catch (e) {
        console.warn('[sync] replay error (falling back to live-only):', e.message || e);
    } finally {
        sync.isReplaying = false;

        // Replay may contain RESET messages that wipe DBSP state (including join
        // indexes). Rebuild DBSP from SQLite so all views — especially joins —
        // have correct state before going live.
        dbsp.reset();
        hydrateFromSQLite(schemaTables);

        emitSyncStatus('live', sync.lastProcessedSeq, { snapshotLoaded: false });

        if (sync.localMutationQueue.length > 0) {
            console.log(`[sync] flushing ${sync.localMutationQueue.length} queued local mutations`);
            for (const msg of sync.localMutationQueue) await handleMessage(msg);
            sync.localMutationQueue = [];
        }
    }
}

// ── NATS connection ─────────────────────────────────────────────────────────

async function connectNats() {
    if (!nats.config) return;

    const natsUrl = nats.config.natsUrl || 'ws://localhost:9222';
    const subject = `ws.${nats.config.workspaceId}.deltas`;

    setConnectionStatus('connecting');

    try {
        const { connect, JSONCodec } = await import('nats.ws');
        const codec = JSONCodec();

        const connectOpts = { servers: natsUrl };
        if (nats.config.authToken) connectOpts.token = nats.config.authToken;
        nats.conn = await connect(connectOpts);
        console.log(`[nats] connected to ${natsUrl}`);

        // Replay historical messages
        await replayFromJetStream(codec, subject);

        setConnectionStatus('connected');

        // Flush offline queues
        for (const msg of nats.outboundQueue) {
            nats.conn.publish(subject, codec.encode(msg));
        }
        nats.outboundQueue = [];
        drainCausalQueue();

        // Reset authority backoff on fresh connection
        authority.backoff = 0;
        authority.backoffUntil = 0;

        // Subscribe to workspace deltas (live)
        nats.sub = nats.conn.subscribe(subject);
        await subscribeAuthority(codec);
        subscribeGC(codec);
        startPeerAckTimer();

        // Inbound message loop
        runInboundLoop(codec);

        // Watch for disconnect
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

// ── Inbound NATS message loop ───────────────────────────────────────────────

async function runInboundLoop(codec) {
    for await (const raw of nats.sub) {
        if (!initialized) continue;

        let msg;
        try { msg = codec.decode(raw.data); } catch { continue; }

        if (msg._clientId === CLIENT_ID) continue;
        if (msg._nonce && dedup(msg._nonce)) continue;

        if (msg.type === 'SCHEMA_MIGRATION' && msg.toVersion && msg.migrations) {
            handleSchemaMigrationNotification(msg);
            continue;
        }

        if (msg.type === 'INSERT' && msg.table && msg.record) {
            handleMessage({
                type: 'INSERT', table: msg.table, record: msg.record,
                _noUndo: true, _fromNats: true,
                _nonce: msg._nonce, _hlc: msg._hlc,
            });
            continue;
        }

        if (msg.type === 'DELETE' && msg.table && msg.id) {
            handleMessage({
                type: 'DELETE', table: msg.table, id: msg.id,
                _fromNats: true,
                _nonce: msg._nonce, _hlc: msg._hlc,
            });
            continue;
        }

        if (msg.type === 'RESET') {
            for (const t of schemaTables) db.exec(`DELETE FROM ${t.name}`);
            dbsp.reset();
            undoStack.length = 0;
            self.postMessage({ type: 'UNDO_SIZE', size: 0 });
            self.postMessage({ type: 'FULL_SYNC', snapshots: {} });
            broadcastReset(msg._nonce);
        }
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
                if (msg.gcWatermark > sync.lastProcessedSeq) {
                    sync.lastProcessedSeq = msg.gcWatermark;
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
        if (nats.config.authToken) headers['Authorization'] = `Bearer ${nats.config.authToken}`;
        fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                clientId: CLIENT_ID,
                userId: nats.config.userId,
                lastSeq: sync.lastProcessedSeq,
            }),
        }).catch(e => console.warn('[gc] peer ack failed:', e.message || e));
    }, PEER_ACK_INTERVAL_MS);
}

// ── Disconnect watcher ──────────────────────────────────────────────────────

async function watchDisconnect() {
    const err = await nats.conn.closed();
    console.log(`[nats] connection closed`, err || '');
    setConnectionStatus('disconnected');
    nats.conn = null;
    nats.sub = null;
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
    if (nats.config.authToken) headers['Authorization'] = `Bearer ${nats.config.authToken}`;

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
    if (!nats.config) return;

    msg._clientId = CLIENT_ID;
    if (nats.config.userId) msg._userId = nats.config.userId;

    const subject = `ws.${nats.config.workspaceId}.deltas`;

    if (nats.conn && !nats.conn.isClosed()) {
        import('nats.ws').then(({ JSONCodec }) => {
            nats.conn.publish(subject, JSONCodec().encode(msg));
        });
    } else if (msg._hlc) {
        enqueueCausal(msg);
    } else {
        nats.outboundQueue.push(msg);
    }
}

// ── Schema migrations ───────────────────────────────────────────────────────

function runMigrations(targetVersion, migrations) {
    db.exec("CREATE TABLE IF NOT EXISTS _dbsp_meta (key TEXT PRIMARY KEY, value TEXT)");

    const rows = db.exec("SELECT value FROM _dbsp_meta WHERE key = 'schema_version'", { rowMode: 'array' });
    const currentVersion = rows.length > 0 ? parseInt(rows[0][0], 10) : 0;

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
    cdcQueue.length = 0;

    if (rows.length > 0) {
        stepEmitBroadcast([{ source: tableName, record: rows[0], weight: -1 }], nonce);
    }
}

// ── Message handlers (broken out from monolithic handleMessage) ─────────────

async function handleInit(data) {
    const { schema } = data;

    // 1. DBSP Engine
    await initDBSP();
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

    // 6. CDC
    setupSQLiteUpdateHook(sqlite3, Object.keys(tablesMeta));

    // 7. Hydrate from persisted data
    schemaTables = schema.tables;
    hydrateFromSQLite(schemaTables);

    self.postMessage({ type: 'READY' });

    // 8. Connect to NATS
    if (data.sync) {
        nats.config = data.sync;
        if (data.sync.restateUrl) authority.restateUrl = data.sync.restateUrl;
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

    // HLC: tick for local, merge for remote
    const hlc = (data._fromNats && data._hlc) ? hlcMerge(data._hlc) : hlcTick();

    const values = meta.columns.map(col => record[col] ?? null);
    db.exec(meta.insertSql, { bind: values });

    if (!data._noUndo) {
        const idCol = meta.columns[0];
        undoStack.push({ table: tableName, id: record[idCol] });
        if (undoStack.length > UNDO_MAX_SIZE) undoStack.shift();
        self.postMessage({ type: 'UNDO_SIZE', size: undoStack.length });
    }

    if (!data._fromNats && !data._localOnly) {
        natsPublish({ type: 'INSERT', table: tableName, record, _nonce: nonce, _hlc: hlc });
    }

    drainCDCQueue(nonce);
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
    nats.outboundQueue = [];

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
    if (!initialized && event.data.type !== 'INIT') {
        pendingMessages.push(event.data);
        return;
    }
    await handleMessage(event.data);
};

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

// ── CDC ─────────────────────────────────────────────────────────────────────

function setupSQLiteUpdateHook(sqlite3, trackedTables) {
    const SQLITE_DELETE = 9;
    const SQLITE_INSERT = 18;
    const SQLITE_UPDATE = 23;

    sqlite3.capi.sqlite3_update_hook(
        db,
        (_pCtx, opId, _dbName, tblName, rowId) => {
            if (!trackedTables.includes(tblName)) return;

            let weight = 0;
            if (opId === SQLITE_INSERT) weight = 1;
            if (opId === SQLITE_DELETE) weight = -1;
            if (opId === SQLITE_UPDATE) weight = 1;

            if (weight !== 0) {
                cdcQueue.push({ table: tblName, rowId: Number(rowId), weight });
            }
        },
        0
    );
}

function drainCDCQueue(nonce) {
    if (cdcQueue.length === 0) return;

    const deltas = [];

    while (cdcQueue.length > 0) {
        const { table: tblName, rowId, weight } = cdcQueue.shift();
        const meta = tablesMeta[tblName];
        if (!meta) continue;

        const idCol = meta.columns[0];
        const result = db.exec(`SELECT * FROM ${tblName} WHERE ${idCol} = ?`, { bind: [rowId], rowMode: 'object' });

        if (result.length > 0) {
            deltas.push({ source: tblName, record: result[0], weight });
        } else if (weight < 0) {
            const synthetic = {};
            synthetic[idCol] = rowId;
            deltas.push({ source: tblName, record: synthetic, weight });
        }
    }

    stepEmitBroadcast(deltas, nonce);
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
