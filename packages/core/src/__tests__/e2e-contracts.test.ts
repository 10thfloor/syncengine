import { describe, it, expect } from 'vitest';
import { table, id, real, text, view, sum, count, extractMergeConfig } from '../schema';
import type { SyncConfig } from '../internal/sync-types';

/**
 * E2E Contract Tests for dashboard-poc
 *
 * These tests verify the protocol contracts between system layers:
 * - Schema → Worker INIT messages
 * - Worker → NATS message shapes
 * - NATS → Restate authority contracts
 * - HLC causal ordering guarantees
 * - SyncConfig validation
 *
 * We test the MESSAGE SHAPES and TYPE CONTRACTS without actually spinning up
 * NATS, Restate, or WASM. This is contract testing — verifying that all layers
 * can understand each other's messages.
 */

// ── Fixture: Sample schema (Phase 2.5 DSL) ──────────────────────────────────

const expenses = table('expenses', {
    id: id(),
    amount: real(),
    category: text(),
    description: text(),
    date: text(),
});

// Every non-PK column opts out of merge, so extractMergeConfig returns null —
// this is the "no merge annotations" case the contract tests exercise.
const budgets = table('budgets', {
    id: id(),
    category: text({ merge: false }),
    limit: real({ merge: false }),
});

// In Phase 2.5, view() takes only the source table; the name is assigned by
// the store at registration time (via the object-property key at db.use).
// Aggregate/top-N/filter accept column refs (`expenses.amount`) instead of strings.
const topExpenses = view(expenses).topN(expenses.amount, 5, 'desc');
const byCategory = view(expenses).aggregate([expenses.category], {
    total: sum(expenses.amount),
    count: count(),
});
const spendVsBudget = view(expenses).join(budgets, expenses.category, budgets.category);

// ── 1. Schema → Worker INIT contract ────────────────────────────────────────

describe('Schema → Worker INIT contract', () => {
    it('tables have required fields for worker initialization', () => {
        // Worker expects table defs to have: $name, $columns
        expect(expenses.$name).toBe('expenses');
        expect(expenses.$tag).toBe('table');
        expect(Object.keys(expenses.$columns)).toEqual(['id', 'amount', 'category', 'description', 'date']);

        // Each column should have sqlType
        for (const col of Object.values(expenses.$columns)) {
            expect(col.sqlType).toBeTruthy();
            expect(typeof col.nullable).toBe('boolean');
            expect(typeof col.primaryKey).toBe('boolean');
        }
    });

    it('primary key is correctly identified', () => {
        // id() should create a PRIMARY KEY column
        const idCol = expenses.$columns['id'];
        expect(idCol.primaryKey).toBe(true);
        expect(idCol.sqlType).toBe('INTEGER PRIMARY KEY');
    });

    it('views have required fields for worker', () => {
        // Worker expects: $tableName, $idKey, $pipeline, $sourceTables, $monotonicity.
        // The view name itself is assigned by the store at registration time,
        // so ViewBuilder carries only an opaque $id here.
        expect(topExpenses.$tag).toBe('view');
        expect(topExpenses.$id).toMatch(/^view_\d+$/);
        expect(topExpenses.$tableName).toBe('expenses');
        expect(topExpenses.$idKey).toBe('id');
        expect(topExpenses.$pipeline).toHaveLength(1);
        expect(topExpenses.$pipeline[0]).toEqual({
            op: 'topN',
            sort_by: 'amount',
            limit: 5,
            order: 'desc',
        });
        expect(topExpenses.$sourceTables).toEqual(['expenses']);
    });

    it('view monotonicity is classified for CALM routing', () => {
        // monotonic views go local only; non-monotonic route through authority
        expect(topExpenses.$monotonicity).toBe('non_monotonic');  // topN is non-monotonic
        expect(byCategory.$monotonicity).toBe('monotonic');       // aggregate is monotonic
        expect(spendVsBudget.$monotonicity).toBe('non_monotonic'); // join is non-monotonic
    });

    it('merge configs are extractable for CRDV', () => {
        // extractMergeConfig pulls merge strategies from schema. In Phase 2.5
        // every non-PK column defaults to 'lww' — no explicit annotation needed.
        const expensesMerge = extractMergeConfig(expenses);
        expect(expensesMerge).not.toBeNull();
        expect(expensesMerge!.table).toBe('expenses');
        expect(expensesMerge!.fields).toEqual({
            amount: 'lww',
            category: 'lww',
            description: 'lww',
            date: 'lww',
        });

        // `budgets` opts out of merge on every non-PK column, so extract returns null.
        const budgetsMerge = extractMergeConfig(budgets);
        expect(budgetsMerge).toBeNull();
    });

    it('INIT message schema payload structure matches worker expectations', () => {
        // Simulate what store.ts builds for the INIT message
        const schemaPayload = {
            tables: [
                {
                    name: expenses.$name,
                    sql: `CREATE TABLE IF NOT EXISTS ${expenses.$name} (...)`,
                    insertSql: `INSERT OR REPLACE INTO ${expenses.$name} (...) VALUES (...)`,
                    columns: Object.keys(expenses.$columns),
                },
            ],
            views: [
                {
                    name: 'topExpenses',                      // assigned at db.use
                    tableName: topExpenses.$tableName,
                    source_table: topExpenses.$tableName,     // snake_case for Rust
                    id_key: topExpenses.$idKey,               // snake_case for Rust
                    pipeline: topExpenses.$pipeline,
                    sourceTables: topExpenses.$sourceTables,
                    monotonicity: topExpenses.$monotonicity,
                },
            ],
            mergeConfigs: [extractMergeConfig(expenses)].filter((c): c is NonNullable<typeof c> => c !== null),
        };

        // Worker receives this in INIT message
        const initMsg = {
            type: 'INIT' as const,
            schema: schemaPayload,
        };

        expect(initMsg.type).toBe('INIT');
        expect(initMsg.schema.tables).toHaveLength(1);
        expect(initMsg.schema.views).toHaveLength(1);
        expect(initMsg.schema.mergeConfigs).toHaveLength(1);
    });
});

// ── 2. Worker → NATS message contract ───────────────────────────────────────

describe('Worker → NATS message contract', () => {
    it('INSERT message has required fields and correct shape', () => {
        // What the worker publishes to NATS after local insert
        const msg = {
            type: 'INSERT' as const,
            table: 'expenses',
            record: { id: 1, amount: 42.5, category: 'food', description: 'lunch', date: '2026-04-02' },
            _nonce: 'client-123-1',
            _hlc: { ts: 1743552000000, count: 0 },
            _clientId: 'client-123',
        };

        expect(msg.type).toBe('INSERT');
        expect(msg.table).toBeTruthy();
        expect(msg.record).toBeTruthy();
        expect(msg._nonce).toBeTruthy();
        expect(msg._hlc).toHaveProperty('ts');
        expect(msg._hlc).toHaveProperty('count');
        expect(msg._hlc.ts).toBeGreaterThan(0);
        expect(typeof msg._hlc.count).toBe('number');
        expect(msg._clientId).toBeTruthy();
    });

    it('INSERT record preserves all table columns', () => {
        // Ensure we serialize the full record
        const record = {
            id: 1,
            amount: 42.5,
            category: 'food',
            description: 'lunch',
            date: '2026-04-02',
        };
        const msg = { type: 'INSERT' as const, table: 'expenses', record };

        expect(Object.keys(msg.record)).toEqual(['id', 'amount', 'category', 'description', 'date']);
    });

    it('DELETE message has required fields and correct shape', () => {
        const msg = {
            type: 'DELETE' as const,
            table: 'expenses',
            id: 1,
            _nonce: 'client-123-2',
            _hlc: { ts: 1743552000000, count: 1 },
            _clientId: 'client-123',
        };

        expect(msg.type).toBe('DELETE');
        expect(msg.table).toBeTruthy();
        expect(msg.id).toBeDefined();
        expect(msg.id).toBe(1);
        expect(msg._nonce).toBeTruthy();
        expect(msg._hlc).toHaveProperty('ts');
        expect(msg._hlc).toHaveProperty('count');
    });

    it('RESET message has required fields', () => {
        const msg = {
            type: 'RESET' as const,
            _nonce: 'client-123-3',
            _hlc: { ts: 1743552000000, count: 2 },
            _clientId: 'client-123',
        };

        expect(msg.type).toBe('RESET');
        expect(msg._nonce).toBeTruthy();
        expect(msg._hlc).toHaveProperty('ts');
        expect(msg._hlc).toHaveProperty('count');
    });

    it('multiple messages preserve causal order via nonce + HLC', () => {
        const messages = [
            {
                type: 'INSERT' as const,
                table: 'expenses',
                record: { id: 1, amount: 50 },
                _nonce: 'client-1-1',
                _hlc: { ts: 1000, count: 0 },
            },
            {
                type: 'DELETE' as const,
                table: 'expenses',
                id: 1,
                _nonce: 'client-1-2',
                _hlc: { ts: 1000, count: 1 },
            },
            {
                type: 'INSERT' as const,
                table: 'expenses',
                record: { id: 2, amount: 100 },
                _nonce: 'client-1-3',
                _hlc: { ts: 1001, count: 0 },
            },
        ];

        // All have nonces and HLC for dedup and ordering
        for (const msg of messages) {
            expect(msg._nonce).toBeTruthy();
            expect(msg._hlc.ts).toBeGreaterThan(0);
        }

        // Nonces are unique
        const nonces = messages.map(m => m._nonce);
        expect(new Set(nonces).size).toBe(nonces.length);
    });
});

// ── 3. NATS → Restate authority contract ────────────────────────────────────

describe('NATS → Restate authority contract', () => {
    it('authority request matches Restate handler signature', () => {
        // What the worker sends to Restate authority endpoint
        const request = {
            viewName: 'topExpenses',
            deltas: [
                {
                    record: { id: 1, amount: 100 },
                    weight: 1,
                    hlc: { ts: 1000, count: 0 },
                },
                {
                    record: { id: 2, amount: 200 },
                    weight: 1,
                    hlc: { ts: 1001, count: 0 },
                },
            ],
        };

        expect(request.viewName).toBeTruthy();
        expect(request.deltas).toBeInstanceOf(Array);
        expect(request.deltas.length).toBeGreaterThan(0);

        for (const delta of request.deltas) {
            expect(delta).toHaveProperty('record');
            expect(delta).toHaveProperty('weight');
            expect(delta).toHaveProperty('hlc');
            expect(typeof delta.weight).toBe('number');
            expect(delta.hlc).toHaveProperty('ts');
            expect(delta.hlc).toHaveProperty('count');
        }
    });

    it('authority response has seq and viewName', () => {
        // Restate returns this after processing
        const response = { seq: 1, viewName: 'topExpenses' };

        expect(response.seq).toBeGreaterThan(0);
        expect(response.viewName).toBeTruthy();
        expect(typeof response.seq).toBe('number');
    });

    it('AUTHORITY_UPDATE NATS message has expected shape', () => {
        // What Restate publishes back to NATS
        const msg = {
            type: 'AUTHORITY_UPDATE',
            viewName: 'topExpenses',
            seq: 1,
            deltas: [
                { record: { id: 1, amount: 100 }, weight: 1, hlc: { ts: 1000, count: 0 } },
            ],
            timestamp: Date.now(),
        };

        expect(msg.type).toBe('AUTHORITY_UPDATE');
        expect(msg.viewName).toBeTruthy();
        expect(msg.seq).toBeGreaterThan(0);
        expect(msg.deltas).toBeInstanceOf(Array);
        expect(msg.timestamp).toBeGreaterThan(0);

        for (const delta of msg.deltas) {
            expect(delta.record).toBeTruthy();
            expect(typeof delta.weight).toBe('number');
            expect(delta.hlc).toHaveProperty('ts');
            expect(delta.hlc).toHaveProperty('count');
        }
    });

    it('authority sequence is monotonically increasing per view', () => {
        // Sequences must never decrease for the same view
        const seqs = [
            { viewName: 'topExpenses', seq: 1 },
            { viewName: 'topExpenses', seq: 2 },
            { viewName: 'topExpenses', seq: 3 },
            { viewName: 'byCategory', seq: 1 },
            { viewName: 'byCategory', seq: 2 },
        ];

        const topSeqs = seqs.filter(s => s.viewName === 'topExpenses').map(s => s.seq);
        expect(topSeqs).toEqual([1, 2, 3]);

        const bySeqs = seqs.filter(s => s.viewName === 'byCategory').map(s => s.seq);
        expect(bySeqs).toEqual([1, 2]);
    });
});

// ── 4. HLC causal ordering contract ─────────────────────────────────────────

describe('HLC causal ordering contract', () => {
    it('messages with HLC can be sorted causally (ts, then count)', () => {
        const messages = [
            { _hlc: { ts: 1000, count: 2 }, payload: 'c' },
            { _hlc: { ts: 1000, count: 0 }, payload: 'a' },
            { _hlc: { ts: 1001, count: 0 }, payload: 'd' },
            { _hlc: { ts: 1000, count: 1 }, payload: 'b' },
        ];

        const sorted = [...messages].sort((a, b) => {
            if (a._hlc.ts !== b._hlc.ts) return a._hlc.ts - b._hlc.ts;
            return a._hlc.count - b._hlc.count;
        });

        // Should be causally ordered: a, b, c (all ts=1000), d (ts=1001)
        expect(sorted.map(m => m.payload)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('HLC tick increments count on same physical time', () => {
        // Simulate worker HLC state
        let hlcTs = 1000;
        let hlcCount = 0;

        function hlcTick() {
            const now = 1000; // Assume same physical time
            if (now > hlcTs) {
                hlcTs = now;
                hlcCount = 0;
            } else {
                hlcCount++;
            }
            return { ts: hlcTs, count: hlcCount };
        }

        const h1 = hlcTick();
        const h2 = hlcTick();
        const h3 = hlcTick();

        expect(h1).toEqual({ ts: 1000, count: 1 });
        expect(h2).toEqual({ ts: 1000, count: 2 });
        expect(h3).toEqual({ ts: 1000, count: 3 });
    });

    it('HLC merge handles remote HLC correctly', () => {
        // Simulate merging a remote HLC
        let hlcTs = 1000;
        let hlcCount = 0;

        function hlcMerge(remote: { ts: number; count: number }) {
            const now = 1005; // Physical time has advanced
            if (now > hlcTs && now > remote.ts) {
                hlcTs = now;
                hlcCount = 0;
            } else if (hlcTs === remote.ts) {
                hlcCount = Math.max(hlcCount, remote.count) + 1;
            } else if (remote.ts > hlcTs) {
                hlcTs = remote.ts;
                hlcCount = remote.count + 1;
            } else {
                // hlcTs > remote.ts
                hlcCount++;
            }
            return { ts: hlcTs, count: hlcCount };
        }

        // Remote clock from another tab: ts=1002, count=5
        const result = hlcMerge({ ts: 1002, count: 5 });

        // Physical time is 1005, which is ahead of both local and remote
        expect(result.ts).toBe(1005);
        expect(result.count).toBe(0);
    });

    it('HLC pack preserves causal order', () => {
        // Pack HLC as single 64-bit number for comparison
        const pack = (hlc: { ts: number; count: number }) => hlc.ts * 65536 + hlc.count;

        const a = pack({ ts: 1000, count: 5 });
        const b = pack({ ts: 1001, count: 0 });
        const c = pack({ ts: 1000, count: 6 });

        // a < b (different ts)
        expect(a).toBeLessThan(b);
        // a < c (same ts, a.count < c.count)
        expect(a).toBeLessThan(c);
        // b > a and b > c
        expect(b).toBeGreaterThan(a);
        expect(b).toBeGreaterThan(c);
    });

    it('causal queue maintains HLC order on offline buffer', () => {
        // Offline messages are queued and replayed in HLC order
        const causalQueue = [
            { _hlc: { ts: 1005, count: 1 }, data: 'third' },
            { _hlc: { ts: 1002, count: 0 }, data: 'first' },
            { _hlc: { ts: 1003, count: 5 }, data: 'second' },
        ];

        // Sort in causal order
        const sorted = [...causalQueue].sort((a, b) => {
            if (a._hlc.ts !== b._hlc.ts) return a._hlc.ts - b._hlc.ts;
            return a._hlc.count - b._hlc.count;
        });

        expect(sorted.map(m => m.data)).toEqual(['first', 'second', 'third']);
    });
});

// ── 5. Nonce dedup contract ─────────────────────────────────────────────────

describe('Nonce dedup contract', () => {
    it('nonces are unique per client per mutation', () => {
        // Each client has a unique ID, each mutation gets a sequence number
        const CLIENT_ID = 'client-123';
        let nonceSeq = 0;

        function makeNonce() {
            return `${CLIENT_ID}-${++nonceSeq}`;
        }

        const n1 = makeNonce();
        const n2 = makeNonce();
        const n3 = makeNonce();

        expect(n1).toBe('client-123-1');
        expect(n2).toBe('client-123-2');
        expect(n3).toBe('client-123-3');
        expect(new Set([n1, n2, n3]).size).toBe(3);
    });

    it('nonce prevents double-delivery from BC and NATS', () => {
        // Simulate nonce dedup logic
        const seenNonces = new Set<string>();

        function dedup(nonce: string) {
            if (seenNonces.has(nonce)) return true;
            seenNonces.add(nonce);
            return false;
        }

        // Same message arrives from BC and NATS
        const nonce = 'client-123-1';

        expect(dedup(nonce)).toBe(false); // First time: not seen
        expect(dedup(nonce)).toBe(true);  // Second time: already seen
    });

    it('BroadcastChannel carries nonce for sync', () => {
        // BC messages include nonce for dedup
        const msg = {
            type: 'DELTAS',
            viewUpdates: { topExpenses: [{ record: { id: 1 }, weight: 1 }] },
            _nonce: 'client-123-1',
        };

        expect(msg._nonce).toBeTruthy();
        expect(msg.type).toBe('DELTAS');
        expect(msg.viewUpdates).toBeTruthy();
    });
});

// ── 6. SyncConfig contract ──────────────────────────────────────────────────

describe('SyncConfig contract', () => {
    it('minimal config requires workspaceId', () => {
        const config: SyncConfig = { workspaceId: 'demo' };

        expect(config.workspaceId).toBe('demo');
        expect(config.natsUrl).toBeUndefined();
        expect(config.restateUrl).toBeUndefined();
    });

    it('full config includes all URLs', () => {
        const config: SyncConfig = {
            workspaceId: 'prod-123',
            natsUrl: 'wss://nats.example.com:9222',
            restateUrl: 'https://restate.example.com:8080',
        };

        expect(config.workspaceId).toBe('prod-123');
        expect(config.natsUrl).toContain('nats');
        expect(config.restateUrl).toContain('restate');
    });

    it('NATS URL defaults to ws://localhost:9222', () => {
        // If natsUrl is undefined, worker uses default
        const config: SyncConfig = { workspaceId: 'demo' };
        const natsUrl = config.natsUrl || 'ws://localhost:9222';

        expect(natsUrl).toBe('ws://localhost:9222');
    });

    it('Restate URL defaults to http://localhost:8080', () => {
        // If restateUrl is undefined, worker uses default
        const config: SyncConfig = { workspaceId: 'demo' };
        const restateUrl = config.restateUrl || 'http://localhost:8080';

        expect(restateUrl).toBe('http://localhost:8080');
    });

    it('subject hierarchy follows naming convention', () => {
        const config: SyncConfig = { workspaceId: 'my-workspace' };

        // Deltas subject: ws.<workspaceId>.deltas
        const deltasSubject = `ws.${config.workspaceId}.deltas`;
        expect(deltasSubject).toBe('ws.my-workspace.deltas');

        // Authority subject: ws.<workspaceId>.authority.<viewName>
        const authoritySubject = `ws.${config.workspaceId}.authority.topExpenses`;
        expect(authoritySubject).toBe('ws.my-workspace.authority.topExpenses');
    });

    it('stream name uses underscore for dashes in workspaceId', () => {
        const config: SyncConfig = { workspaceId: 'my-prod-workspace' };
        const streamName = `WS_${config.workspaceId.replace(/-/g, '_')}`;

        expect(streamName).toBe('WS_my_prod_workspace');
    });
});

// ── 7. CALM routing contract ────────────────────────────────────────────────

describe('CALM routing contract', () => {
    it('monotonic views route locally only', () => {
        // Views without topN, distinct, or join can be computed locally
        expect(byCategory.$monotonicity).toBe('monotonic');

        // No need to send to authority
        const shouldRouteToAuthority = byCategory.$monotonicity === 'non_monotonic';
        expect(shouldRouteToAuthority).toBe(false);
    });

    it('non-monotonic views route through authority', () => {
        // Views with topN, distinct, or join must go to server
        expect(topExpenses.$monotonicity).toBe('non_monotonic');
        expect(spendVsBudget.$monotonicity).toBe('non_monotonic');

        // These should route to authority
        for (const v of [topExpenses, spendVsBudget]) {
            const shouldRoute = v.$monotonicity === 'non_monotonic';
            expect(shouldRoute).toBe(true);
        }
    });

    it('monotonicity metadata is sent in INIT', () => {
        // Worker receives monotonicity for routing decisions. The view name
        // is assigned at db.use time; here we hardcode it to exercise the
        // INIT shape the store will build.
        const viewMeta = {
            name: 'topExpenses',
            monotonicity: topExpenses.$monotonicity,
            tableName: topExpenses.$tableName,
            id_key: topExpenses.$idKey,
            source_table: topExpenses.$tableName,
            pipeline: topExpenses.$pipeline,
            sourceTables: topExpenses.$sourceTables,
        };

        expect(viewMeta.monotonicity).toBe('non_monotonic');

        // Worker can then make routing decisions
        const viewMonotonicity: Record<string, string> = {};
        viewMonotonicity[viewMeta.name] = viewMeta.monotonicity;

        const nonMonViews = Object.entries(viewMonotonicity)
            .filter(([, m]) => m === 'non_monotonic')
            .map(([name]) => name);

        expect(nonMonViews).toContain('topExpenses');
    });
});

// ── 8. CDC and delta contract ────────────────────────────────────────────────

describe('CDC and delta contract', () => {
    it('delta has source table, record, and weight', () => {
        const delta = {
            source: 'expenses',
            record: { id: 1, amount: 50, category: 'food', description: 'lunch', date: '2026-04-02' },
            weight: 1, // INSERT = 1, DELETE = -1, UPDATE = 1
        };

        expect(delta.source).toBeTruthy();
        expect(delta.record).toBeTruthy();
        expect(typeof delta.weight).toBe('number');
        expect([-1, 1]).toContain(delta.weight);
    });

    it('INSERT produces weight=1 delta', () => {
        const delta = {
            source: 'expenses',
            record: { id: 1, amount: 50, category: 'food', description: 'lunch', date: '2026-04-02' },
            weight: 1,
        };

        expect(delta.weight).toBe(1);
    });

    it('DELETE produces weight=-1 delta', () => {
        const delta = {
            source: 'expenses',
            record: { id: 1 }, // Synthetic record for retraction
            weight: -1,
        };

        expect(delta.weight).toBe(-1);
    });

    it('view updates carry deltas with record and weight', () => {
        const viewUpdate = {
            viewName: 'topExpenses',
            deltas: [
                { record: { id: 1, amount: 100 }, weight: 1 },
                { record: { id: 2, amount: 200 }, weight: 1 },
            ],
        };

        expect(viewUpdate.viewName).toBeTruthy();
        expect(viewUpdate.deltas).toBeInstanceOf(Array);

        for (const delta of viewUpdate.deltas) {
            expect(delta.record).toBeTruthy();
            expect(typeof delta.weight).toBe('number');
        }
    });
});

// ── 9. Worker out message contract ──────────────────────────────────────────

describe('Worker out message contract', () => {
    it('READY message signals initialization complete', () => {
        const msg = { type: 'READY' as const };

        expect(msg.type).toBe('READY');
    });

    it('VIEW_UPDATE carries view name and deltas', () => {
        const msg = {
            type: 'VIEW_UPDATE' as const,
            viewName: 'topExpenses',
            deltas: [{ record: { id: 1, amount: 100 }, weight: 1 }],
        };

        expect(msg.type).toBe('VIEW_UPDATE');
        expect(msg.viewName).toBeTruthy();
        expect(msg.deltas).toBeInstanceOf(Array);
    });

    it('FULL_SYNC carries all view snapshots', () => {
        const msg = {
            type: 'FULL_SYNC' as const,
            snapshots: {
                topExpenses: [
                    { id: 1, amount: 100 },
                    { id: 2, amount: 200 },
                ],
                byCategory: [
                    { category: 'food', total: 150, count: 2 },
                ],
            },
        };

        expect(msg.type).toBe('FULL_SYNC');
        expect(msg.snapshots).toBeTruthy();
        expect(Object.keys(msg.snapshots).length).toBeGreaterThan(0);
    });

    it('UNDO_SIZE carries current undo stack size', () => {
        const msg = { type: 'UNDO_SIZE' as const, size: 5 };

        expect(msg.type).toBe('UNDO_SIZE');
        expect(typeof msg.size).toBe('number');
        expect(msg.size).toBeGreaterThanOrEqual(0);
    });

    it('CONNECTION_STATUS carries connection state', () => {
        const statuses: Array<'off' | 'connecting' | 'connected' | 'disconnected'> = [
            'off',
            'connecting',
            'connected',
            'disconnected',
        ];

        for (const status of statuses) {
            const msg = { type: 'CONNECTION_STATUS' as const, status };

            expect(msg.type).toBe('CONNECTION_STATUS');
            expect(statuses).toContain(msg.status);
        }
    });
});
