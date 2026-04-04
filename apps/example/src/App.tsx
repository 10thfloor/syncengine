import { useState, useEffect, useCallback } from 'react';
import {
    table, id, real, text, view, store,
    sum, count, avg, max,
    useStore, useEntity,
    type ConflictRecord, type SyncStatus, type ConnectionStatus, type Migration,
} from '@syncengine/client';
import { budgetLock } from './entities/budget-lock.actor';
import './App.css';

// Stable per-tab identity for the actor model lock holder field. One tab
// gets one uuid; every BudgetLockButton in this tab uses the same value
// as the lock holder. Reload generates a fresh id (= different "tab").
const TAB_ID = crypto.randomUUID();

// ── Schema ────────────────────────────────────────────────────────────────
//
// No `{ merge: 'lww' }` sprinkled on every column — it's the default.
// No `_record`/`name` string keys — views use `expenses.amount` column refs.
// Enum columns narrow the category value type to a string union.

const CATEGORIES = ['Food', 'Travel', 'Software', 'Office', 'Entertainment'] as const;

const expenses = table('expenses', {
    id: id(),
    amount: real(),
    category: text({ enum: CATEGORIES }),
    description: text(),
    date: text(),
});

const budgets = table('budgets', {
    id: id(),
    category: text({ enum: CATEGORIES }),
    budget: real(),
});

// ── Views — by ref, not by string ─────────────────────────────────────────

const topExpenses = view(expenses).topN(expenses.amount, 5, 'desc');

const byCategory = view(expenses).aggregate([expenses.category], {
    total: sum(expenses.amount),
    count: count(),
    avg: avg(expenses.amount),
});

const totals = view(expenses).aggregate([], {
    total: sum(expenses.amount),
    count: count(),
    avg: avg(expenses.amount),
});

const spendVsBudget = view(expenses)
    .join(budgets, expenses.category, budgets.category)
    .aggregate([expenses.category], {
        spent: sum(expenses.amount),
        budget: max(budgets.budget),
        count: count(),
    });

// ── Migrations ────────────────────────────────────────────────────────────

const migrations: readonly Migration[] = [
    {
        version: 2,
        steps: [
            { op: 'addColumn', table: 'expenses', column: 'tags', type: 'TEXT', default: '', nullable: false },
        ],
    },
];

// ── Channels — by Table reference, not string ────────────────────────────

const CHANNELS = [
    { name: 'config', tables: [budgets] },
    { name: 'team', tables: [expenses] },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────

type Category = typeof CATEGORIES[number];

const EMOJI: Record<Category, string> = {
    Food: '🍔',
    Travel: '✈️',
    Software: '💻',
    Office: '📦',
    Entertainment: '🎬',
};

const BUDGET_LIMITS: Record<Category, number> = {
    Food: 2000,
    Travel: 5000,
    Software: 3000,
    Office: 4000,
    Entertainment: 1500,
};

const fmt = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// ── Store ─────────────────────────────────────────────────────────────────
//
// Typed seed: keys constrained to `'expenses' | 'budgets'`, row shapes
// constrained to each table's record. Replayed automatically on ready /
// phase=live / after actions.reset() — no manual useEffect chains.

export const db = store({
    tables: [expenses, budgets],
    views: [topExpenses, byCategory, totals, spendVsBudget],
    channels: CHANNELS,
    seed: {
        budgets: CATEGORIES.map((cat, i) => ({
            id: i + 1,
            category: cat,
            budget: BUDGET_LIMITS[cat],
        })),
    },
    schemaVersion: 1,
    migrations,
});

export type DB = typeof db;

// ── Sync status badge ─────────────────────────────────────────────────────

function SyncBadge({ status, sync }: { status: ConnectionStatus; sync: SyncStatus }) {
    if (status === 'off') return <span className="badge dim">Local only</span>;
    if (status === 'auth_failed') return <span className="badge red">Auth failed</span>;
    if (status === 'disconnected') return <span className="badge red">Offline</span>;
    if (status === 'syncing' || sync.phase === 'replaying') {
        const pct = sync.totalMessages
            ? Math.round((sync.messagesReplayed / sync.totalMessages) * 100)
            : null;
        return <span className="badge yellow">Syncing{pct !== null ? ` ${pct}%` : '...'}</span>;
    }
    if (status === 'connecting') return <span className="badge yellow">Connecting</span>;
    return <span className="badge green">Synced</span>;
}

// ── Budget lock button (Phase 4 actor demo) ──────────────────────────────
//
// Each budget category gets its own `useEntity(budgetLock, category)`
// instance — a Restate-backed actor that serializes acquire/release calls
// across every tab in the workspace. The lock TYPE is one Restate object
// (`entity_budgetLock`); each category KEY is a separate virtual-object
// instance with its own state and serialized handler execution.
//
// Try it: click "Lock Food" in tab A, then try the same in tab B. Tab B
// gets a clear "Locked by 'tab-A-uuid'" error. Release in tab A, click
// in tab B — succeeds. State updates fan out via NATS so the visual
// "locked / unlocked" badge updates without polling.

function BudgetLockButton({ category }: { category: Category }) {
    const { state, actions, ready, error } = useEntity(budgetLock, category);
    const isHeldByMe = state?.holder === TAB_ID;
    const isLocked = !!state?.holder;

    const onClick = useCallback(async () => {
        try {
            if (isHeldByMe) {
                await actions.release(TAB_ID);
            } else {
                await actions.acquire(TAB_ID, category, Date.now());
            }
        } catch {
            // Error is exposed via the `error` field — no need to log here.
        }
    }, [actions, category, isHeldByMe]);

    const label = !ready
        ? '…'
        : isHeldByMe
            ? 'Unlock'
            : isLocked
                ? `🔒 ${(state?.holder ?? '').slice(0, 4)}`
                : 'Lock';

    return (
        <button
            type="button"
            className={`btn btn-ghost btn-sm budget-lock${isHeldByMe ? ' held' : ''}${isLocked && !isHeldByMe ? ' contended' : ''}`}
            onClick={onClick}
            disabled={!ready || (isLocked && !isHeldByMe)}
            title={error ? error.message : isHeldByMe ? 'You hold this lock' : isLocked ? `Held by ${state?.holder}` : 'Click to acquire'}
        >
            {label}
        </button>
    );
}

// ── Conflict panel ────────────────────────────────────────────────────────

function ConflictPanel({
    conflicts,
    onDismiss,
}: {
    conflicts: readonly ConflictRecord[];
    onDismiss: (i: number) => void;
}) {
    const active = conflicts.filter((c) => !c.dismissed);
    if (active.length === 0) return null;

    return (
        <div className="panel conflict-panel">
            <h2>Conflicts ({active.length})</h2>
            <div className="conflict-list">
                {active.map((c) => {
                    const realIndex = conflicts.indexOf(c);
                    return (
                        <div
                            key={`${c.table}-${c.recordId}-${c.field}-${c.resolvedAt}`}
                            className="conflict-item"
                        >
                            <div className="conflict-header">
                                <span className="conflict-field">
                                    {c.table}.{c.field}
                                </span>
                                <span className="badge purple" style={{ fontSize: '10px' }}>
                                    {c.strategy.toUpperCase()}
                                </span>
                                <button
                                    type="button"
                                    className="conflict-dismiss"
                                    onClick={() => onDismiss(realIndex)}
                                >
                                    dismiss
                                </button>
                            </div>
                            <div className="conflict-values">
                                <span className="conflict-winner">
                                    Winner: {JSON.stringify(c.winner.value)}
                                </span>
                                <span className="conflict-loser">
                                    Loser: {JSON.stringify(c.loser.value)}
                                </span>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ── Main app ──────────────────────────────────────────────────────────────

export default function App() {
    // Single consolidated hook. Views keyed by name. All typed — no casts.
    const db = useStore<DB>();
    const { views, ready, connection, sync, conflicts, undo, actions } = db.use({
        topExpenses,
        byCategory,
        totals,
        spendVsBudget,
    });

    const [desc, setDesc] = useState('');
    const [amount, setAmount] = useState('');
    const [category, setCategory] = useState<Category>(CATEGORIES[0]);
    const [showDebug, setShowDebug] = useState(false);

    // Reveal the app once the engine is ready
    useEffect(() => {
        if (ready) document.getElementById('root')?.classList.add('ready');
    }, [ready]);

    // Cmd+Z / Ctrl+Z undo
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo.run();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [undo]);

    const stats = views.totals[0] ?? { total: 0, count: 0, avg: 0 };

    const handleAdd = useCallback(() => {
        const amt = Number.parseFloat(amount);
        if (!desc.trim() || isNaN(amt) || amt <= 0) return;
        db.tables.expenses.insert({
            amount: amt,
            category,
            description: desc.trim(),
            date: new Date().toISOString().slice(0, 10),
        });
        setDesc('');
        setAmount('');
    }, [db, amount, desc, category]);

    const handleRandom = useCallback(() => {
        const cat = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
        const descs: Record<Category, string[]> = {
            Food: ['Team lunch', 'Coffee run', 'Client dinner', 'Snacks'],
            Travel: ['Flight to NYC', 'Uber to airport', 'Hotel 2 nights', 'Train ticket'],
            Software: ['Figma annual', 'GitHub Teams', 'Vercel Pro', 'Linear'],
            Office: ['Standing desk', 'Monitor', 'Keyboard', 'Webcam'],
            Entertainment: ['Team outing', 'Conference ticket', 'Books', 'Workshop'],
        };
        const d = descs[cat][Math.floor(Math.random() * descs[cat].length)];
        const a = Math.floor(Math.random() * 2000) + 50;
        db.tables.expenses.insert({
            amount: a,
            category: cat,
            description: d,
            date: new Date().toISOString().slice(0, 10),
        });
    }, [db]);

    // Simulate a remote peer editing the top expense → LWW conflict
    const handleSimulateConflict = useCallback(() => {
        const top = views.topExpenses;
        if (top.length === 0) return;
        const target = top[0];
        db.tables.expenses.insert({
            ...target,
            amount: Math.floor(Math.random() * 5000) + 100,
            description: `${target.description} (remote edit)`,
        });
    }, [db, views.topExpenses]);

    const activeConflicts = conflicts.filter((c) => !c.dismissed);

    return (
        <div className="app">
            {/* ── Header ────────────────────────────────────────────── */}
            <div className="header">
                <h1>Team Expenses</h1>
                <div className="header-badges">
                    <span className="badge green">{ready ? '● Live' : '○ Loading'}</span>
                    <span className="badge blue">4 views</span>
                    <span
                        className="badge purple"
                        title={CHANNELS.map((c) => `${c.name}: ${c.tables.map((t) => t.$name).join(', ')}`).join(' · ')}
                    >
                        {CHANNELS.length} channels
                    </span>
                    <SyncBadge status={connection} sync={sync} />
                    {activeConflicts.length > 0 && (
                        <span className="badge orange">
                            {activeConflicts.length} conflict{activeConflicts.length !== 1 ? 's' : ''}
                        </span>
                    )}
                </div>
            </div>

            {/* ── Stats ─────────────────────────────────────────────── */}
            <div className="stats-row">
                <div className="stat-card">
                    <div className="label">Total Spent</div>
                    <div className="value">{fmt(stats.total)}</div>
                </div>
                <div className="stat-card">
                    <div className="label">Expenses</div>
                    <div className="value">{stats.count}</div>
                </div>
                <div className="stat-card">
                    <div className="label">Average</div>
                    <div className="value">{fmt(stats.avg)}</div>
                </div>
            </div>

            {/* ── Add expense ────────────────────────────────────────── */}
            <div className="add-bar">
                <input
                    placeholder="Description..."
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                />
                <input
                    type="number"
                    placeholder="Amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                />
                <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as Category)}
                >
                    {CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                    ))}
                </select>
                <button className="btn btn-primary" onClick={handleAdd} disabled={!ready}>Add</button>
                <button className="btn btn-ghost" onClick={handleRandom} disabled={!ready}>Random</button>
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={undo.run}
                    disabled={undo.size === 0}
                >
                    Undo{undo.size > 0 ? ` (${undo.size})` : ''}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={actions.reset}>Reset</button>
            </div>

            {/* ── Conflict panel ─────────────────────────────────────── */}
            <ConflictPanel conflicts={conflicts} onDismiss={actions.dismissConflict} />

            {/* ── Panels ─────────────────────────────────────────────── */}
            <div className="panels">
                <div className="panels-left">
                    <div className="panel">
                        <h2>By Category</h2>
                        <div className="cat-totals">
                            {[...views.byCategory]
                                .sort((a, b) => b.total - a.total)
                                .map((cat, i) => (
                                    <div key={`${cat.category}-${i}`} className="cat-chip">
                                        <span className="cat-emoji">{EMOJI[cat.category] ?? '📁'}</span>
                                        <span className="cat-name">{cat.category}</span>
                                        <span className="cat-amount">{fmt(cat.total)}</span>
                                    </div>
                                ))}
                        </div>
                    </div>

                    <div className="panel">
                        <h2>Top 5</h2>
                        <div className="top-compact">
                            {views.topExpenses.map((exp, i) => (
                                <div key={exp.id} className="top-row">
                                    <span className="top-rank">{i + 1}</span>
                                    <span className="top-desc">{exp.description}</span>
                                    <span className="top-amt">{fmt(exp.amount)}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="panels-right">
                    <div className="panel">
                        <h2>
                            Budget Tracker{' '}
                            <span className="badge purple" style={{ fontSize: '0.65rem', verticalAlign: 'middle' }}>
                                JOIN
                            </span>
                        </h2>
                        <ul className="budget-list">
                            {[...views.spendVsBudget]
                                .sort((a, b) => b.spent - a.spent)
                                .map((row, i) => {
                                    const pct = row.budget > 0 ? Math.min((row.spent / row.budget) * 100, 100) : 0;
                                    const over = row.spent > row.budget;
                                    return (
                                        <li key={`${row.category}-${i}`} className="budget-item">
                                            <div className="budget-header">
                                                <span className="name">
                                                    {EMOJI[row.category] ?? '📁'} {row.category}
                                                </span>
                                                <BudgetLockButton category={row.category} />
                                                <span className={`budget-amounts ${over ? 'over' : ''}`}>
                                                    {fmt(row.spent)} / {fmt(row.budget)}
                                                </span>
                                            </div>
                                            <div className="budget-bar">
                                                <div
                                                    className={`budget-fill ${over ? 'over' : ''}`}
                                                    style={{ width: `${pct}%` }}
                                                />
                                            </div>
                                        </li>
                                    );
                                })}
                        </ul>
                    </div>
                </div>
            </div>

            {/* ── Footer + debug toggle ──────────────────────────────── */}
            <div className="footer">
                <span><span className="dot green" /> OPFS</span>
                <span><span className="dot blue" /> DBSP</span>
                <span><span className="dot purple" /> JetStream</span>
                <button className="debug-toggle" onClick={() => setShowDebug((v) => !v)}>
                    {showDebug ? 'Hide' : 'Show'} sync debug
                </button>
            </div>

            {/* ── Debug panel ─────────────────────────────────────────── */}
            {showDebug && (
                <div className="debug-panel">
                    <div className="debug-grid">
                        <div className="debug-item">
                            <span className="debug-label">Connection</span>
                            <span className={`debug-value ${connection === 'connected' ? 'ok' : 'warn'}`}>
                                {connection}
                            </span>
                        </div>
                        <div className="debug-item">
                            <span className="debug-label">Sync phase</span>
                            <span className="debug-value">{sync.phase}</span>
                        </div>
                        <div className="debug-item">
                            <span className="debug-label">Replayed</span>
                            <span className="debug-value">
                                {sync.messagesReplayed}
                                {sync.totalMessages ? ` / ${sync.totalMessages}` : ''}
                            </span>
                        </div>
                        <div className="debug-item">
                            <span className="debug-label">Snapshot</span>
                            <span className="debug-value">{sync.snapshotLoaded ? 'loaded' : 'none'}</span>
                        </div>
                        <div className="debug-item">
                            <span className="debug-label">Conflicts</span>
                            <span className="debug-value">
                                {conflicts.length} total, {activeConflicts.length} active
                            </span>
                        </div>
                        <div className="debug-item">
                            <span className="debug-label">Schema</span>
                            <span className="debug-value">v1</span>
                        </div>
                        {CHANNELS.map((ch) => (
                            <div key={ch.name} className="debug-item">
                                <span className="debug-label">ch · {ch.name}</span>
                                <span className="debug-value">
                                    {ch.tables.map((t) => t.$name).join(', ')}
                                </span>
                            </div>
                        ))}
                    </div>
                    <div className="debug-actions">
                        <button
                            className="btn btn-ghost btn-sm"
                            onClick={handleSimulateConflict}
                            disabled={views.topExpenses.length === 0}
                        >
                            Simulate conflict
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

