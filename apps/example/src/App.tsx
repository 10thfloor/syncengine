import { useState, useEffect, useCallback } from "react";
import {
  table,
  id,
  real,
  text,
  view,
  store,
  sum,
  count,
  avg,
  max,
} from "@syncengine/client";
import type {
  ConflictRecord,
  SyncStatus,
  ConnectionStatus,
  Migration,
  ChannelConfig,
} from "@syncengine/client";
import "./App.css";

// ── Schema (v1) ────────────────────────────────────────────────────────────

const expenses = table("expenses", {
  id: id(),
  amount: real({ merge: "lww" }),
  category: text({ merge: "lww" }),
  description: text({ merge: "lww" }),
  date: text({ merge: "lww" }),
});

const topExpenses = view("topExpenses", expenses).topN("amount", 5, "desc");

const byCategory = view("byCategory", expenses).aggregate(["category"], {
  total: sum("amount"),
  count: count(),
  avg: avg("amount"),
});

const totals = view("totals", expenses).aggregate([], {
  total: sum("amount"),
  count: count(),
  avg: avg("amount"),
});

const budgets = table("budgets", {
  id: id(),
  category: text(),
  budget: real(),
});

const spendVsBudget = view("spendVsBudget", expenses)
  .join(budgets, "category", "category")
  .aggregate(["category"], {
    spent: sum("amount"),
    budget: max("budget"),
    count: count(),
  });

// ── Migrations ─────────────────────────────────────────────────────────────

const migrations: Migration[] = [
  {
    version: 2,
    steps: [
      {
        op: "addColumn",
        table: "expenses",
        column: "tags",
        type: "TEXT",
        default: "",
        nullable: false,
      },
    ],
  },
];

// ── Channels ────────────────────────────────────────────────────────────────
// Each channel maps to its own NATS subject for per-channel access control:
//   ws.demo.ch.config.deltas  ← budgets (admin-set, low write volume)
//   ws.demo.ch.team.deltas    ← expenses (team writes, high volume)
//
// A NATS server can ACL these subjects independently — e.g. only managers can
// publish to `config`, while everyone on the team can publish to `team`. The
// `spendVsBudget` view joins across both channels, so a user with read access
// to only one channel still gets a correct (but partial) view.
const CHANNELS: ChannelConfig[] = [
  { name: "config", tables: ["budgets"] },
  { name: "team", tables: ["expenses"] },
];

// ── Store ───────────────────────────────────────────────────────────────────

const db = store({
  tables: [expenses, budgets],
  views: [topExpenses, byCategory, totals, spendVsBudget],
  sync: {
    workspaceId: "demo",
    natsUrl: "ws://localhost:9222",
    channels: CHANNELS,
  },
  schemaVersion: 1,
  migrations,
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const CATEGORIES = ["Food", "Travel", "Software", "Office", "Entertainment"];
const EMOJI: Record<string, string> = {
  Food: "🍔",
  Travel: "✈️",
  Software: "💻",
  Office: "📦",
  Entertainment: "🎬",
};
const BUDGET_LIMITS: Record<string, number> = {
  Food: 2000,
  Travel: 5000,
  Software: 3000,
  Office: 4000,
  Entertainment: 1500,
};

const fmt = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

// ── Sync status badge ──────────────────────────────────────────────────────

function SyncBadge({
  status,
  syncStatus,
}: {
  status: ConnectionStatus;
  syncStatus: SyncStatus;
}) {
  if (status === "off") return <span className="badge dim">Local only</span>;
  if (status === "auth_failed")
    return <span className="badge red">Auth failed</span>;
  if (status === "disconnected")
    return <span className="badge red">Offline</span>;
  if (status === "syncing" || syncStatus.phase === "replaying") {
    const pct = syncStatus.totalMessages
      ? Math.round(
          (syncStatus.messagesReplayed / syncStatus.totalMessages) * 100,
        )
      : null;
    return (
      <span className="badge yellow">
        Syncing{pct !== null ? ` ${pct}%` : "..."}
      </span>
    );
  }
  if (status === "connecting")
    return <span className="badge yellow">Connecting</span>;
  return <span className="badge green">Synced</span>;
}

// ── Conflict panel ─────────────────────────────────────────────────────────

function ConflictPanel({
  conflicts,
  onDismiss,
}: {
  conflicts: ConflictRecord[];
  onDismiss: (i: number) => void;
}) {
  const active = conflicts.filter((c) => !c.dismissed);
  if (active.length === 0) return null;

  return (
    <div className="panel conflict-panel">
      <h2>Conflicts ({active.length})</h2>
      <div className="conflict-list">
        {active.map((c, i) => {
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
                <span className="badge purple" style={{ fontSize: "10px" }}>
                  {c.strategy.toUpperCase()}
                </span>
                <button
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

// ── Main app ───────────────────────────────────────────────────────────────

export default function App() {
  const { data: top, insert, ready } = db.useView(topExpenses);
  const { data: categories } = db.useView(byCategory);
  const { data: summary } = db.useView(totals);
  const { data: budgetData } = db.useView(spendVsBudget);
  const undoSize = db.useUndoSize();
  const netStatus = db.useConnectionStatus();
  const syncStatus = db.useSyncStatus();
  const conflicts = db.useConflicts();

  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [showDebug, setShowDebug] = useState(false);

  // Reveal the app once the engine is ready
  useEffect(() => {
    if (ready) document.getElementById("root")?.classList.add("ready");
  }, [ready]);

  // Seed budget rows on ready AND after replay completes.
  // Replay may contain a RESET that wipes SQLite + DBSP join indexes.
  // Re-seeding is idempotent (INSERT OR REPLACE) and _localOnly (no NATS publish).
  const seedBudgets = useCallback(() => {
    CATEGORIES.forEach((cat, i) => {
      db.insertSeed("budgets", {
        id: i + 1,
        category: cat,
        budget: BUDGET_LIMITS[cat],
      });
    });
  }, []);
  useEffect(() => {
    if (ready) seedBudgets();
  }, [ready, seedBudgets]);
  useEffect(() => {
    if (ready && syncStatus.phase === "live") seedBudgets();
  }, [syncStatus.phase, ready, seedBudgets]);

  // Cmd+Z / Ctrl+Z undo
  const handleUndo = useCallback(() => {
    db.undo();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleUndo]);

  const stats = summary[0] ?? { total: 0, count: 0, avg: 0 };

  const handleAdd = () => {
    const amt = Number.parseFloat(amount);
    if (!desc.trim() || isNaN(amt) || amt <= 0) return;
    insert({
      id: Date.now(),
      amount: amt,
      category,
      description: desc.trim(),
      date: new Date().toISOString().slice(0, 10),
    });
    setDesc("");
    setAmount("");
  };

  const handleRandom = () => {
    const cat = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    const descs: Record<string, string[]> = {
      Food: ["Team lunch", "Coffee run", "Client dinner", "Snacks"],
      Travel: [
        "Flight to NYC",
        "Uber to airport",
        "Hotel 2 nights",
        "Train ticket",
      ],
      Software: ["Figma annual", "GitHub Teams", "Vercel Pro", "Linear"],
      Office: ["Standing desk", "Monitor", "Keyboard", "Webcam"],
      Entertainment: ["Team outing", "Conference ticket", "Books", "Workshop"],
    };
    const d = descs[cat][Math.floor(Math.random() * descs[cat].length)];
    const a = Math.floor(Math.random() * 2000) + 50;
    insert({
      id: Date.now() + Math.floor(Math.random() * 1000),
      amount: a,
      category: cat,
      description: d,
      date: new Date().toISOString().slice(0, 10),
    });
  };

  // Simulate a remote peer editing the same record — triggers LWW conflict
  const handleSimulateConflict = () => {
    if (top.length === 0) return;
    const target = top[0]; // Edit the top expense
    const newAmount = Math.floor(Math.random() * 5000) + 100;
    // Insert with the same ID overwrites → triggers LWW merge conflict
    insert({
      ...target,
      amount: newAmount,
      description: `${target.description} (remote edit)`,
    });
  };

  const handleReset = () => {
    db.reset();
    setTimeout(() => {
      CATEGORIES.forEach((cat, i) => {
        db.insertSeed("budgets", {
          id: i + 1,
          category: cat,
          budget: BUDGET_LIMITS[cat],
        });
      });
    }, 50);
  };

  const activeConflicts = conflicts.filter((c) => !c.dismissed);

  return (
    <div className="app">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="header">
        <h1>Team Expenses</h1>
        <div className="header-badges">
          <span className="badge green">{ready ? "● Live" : "○ Loading"}</span>
          <span className="badge blue">4 views</span>
          <span
            className="badge purple"
            title={CHANNELS.map(
              (c) => `${c.name}: ${c.tables.join(", ")}`,
            ).join(" · ")}
          >
            {CHANNELS.length} channels
          </span>
          <SyncBadge status={netStatus} syncStatus={syncStatus} />
          {activeConflicts.length > 0 && (
            <span className="badge orange">
              {activeConflicts.length} conflict
              {activeConflicts.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* ── Stats ───────────────────────────────────────────────────── */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="label">Total Spent</div>
          <div className="value">{fmt(stats.total as number)}</div>
        </div>
        <div className="stat-card">
          <div className="label">Expenses</div>
          <div className="value">{stats.count as number}</div>
        </div>
        <div className="stat-card">
          <div className="label">Average</div>
          <div className="value">{fmt(stats.avg as number)}</div>
        </div>
      </div>

      {/* ── Add expense ─────────────────────────────────────────────── */}
      <div className="add-bar">
        <input
          placeholder="Description..."
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <input
          type="number"
          placeholder="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          className="btn btn-primary"
          onClick={handleAdd}
          disabled={!ready}
        >
          Add
        </button>
        <button
          className="btn btn-ghost"
          onClick={handleRandom}
          disabled={!ready}
        >
          Random
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={handleUndo}
          disabled={undoSize === 0}
        >
          Undo{undoSize > 0 ? ` (${undoSize})` : ""}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={handleReset}>
          Reset
        </button>
      </div>

      {/* ── Conflict panel ──────────────────────────────────────────── */}
      <ConflictPanel
        conflicts={conflicts}
        onDismiss={(i) => db.dismissConflict(i)}
      />

      {/* ── Panels ──────────────────────────────────────────────────── */}
      <div className="panels">
        <div className="panels-left">
          <div className="panel">
            <h2>By Category</h2>
            <div className="cat-totals">
              {[...categories]
                .sort((a, b) => (b.total as number) - (a.total as number))
                .map((cat, i) => (
                  <div key={`${cat.category}-${i}`} className="cat-chip">
                    <span className="cat-emoji">
                      {EMOJI[cat.category as string] ?? "📁"}
                    </span>
                    <span className="cat-name">{cat.category as string}</span>
                    <span className="cat-amount">
                      {fmt(cat.total as number)}
                    </span>
                  </div>
                ))}
            </div>
          </div>

          <div className="panel">
            <h2>Top 5</h2>
            <div className="top-compact">
              {top.map((exp, i) => (
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
              Budget Tracker{" "}
              <span
                className="badge purple"
                style={{ fontSize: "0.65rem", verticalAlign: "middle" }}
              >
                JOIN
              </span>
            </h2>
            <ul className="budget-list">
              {[...budgetData]
                .sort((a, b) => (b.spent as number) - (a.spent as number))
                .map((row, i) => {
                  const spent = row.spent as number;
                  const limit = row.budget as number;
                  const pct =
                    limit > 0 ? Math.min((spent / limit) * 100, 100) : 0;
                  const over = spent > limit;
                  return (
                    <li key={`${row.category}-${i}`} className="budget-item">
                      <div className="budget-header">
                        <span className="name">
                          {EMOJI[row.category as string] ?? "📁"}{" "}
                          {row.category as string}
                        </span>
                        <span
                          className={`budget-amounts ${over ? "over" : ""}`}
                        >
                          {fmt(spent)} / {fmt(limit)}
                        </span>
                      </div>
                      <div className="budget-bar">
                        <div
                          className={`budget-fill ${over ? "over" : ""}`}
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

      {/* ── Footer + debug toggle ───────────────────────────────────── */}
      <div className="footer">
        <span>
          <span className="dot green" /> OPFS
        </span>
        <span>
          <span className="dot blue" /> DBSP
        </span>
        <span>
          <span className="dot purple" /> JetStream
        </span>
        <button
          className="debug-toggle"
          onClick={() => setShowDebug((v) => !v)}
        >
          {showDebug ? "Hide" : "Show"} sync debug
        </button>
      </div>

      {/* ── Debug panel ─────────────────────────────────────────────── */}
      {showDebug && (
        <div className="debug-panel">
          <div className="debug-grid">
            <div className="debug-item">
              <span className="debug-label">Connection</span>
              <span
                className={`debug-value ${netStatus === "connected" ? "ok" : "warn"}`}
              >
                {netStatus}
              </span>
            </div>
            <div className="debug-item">
              <span className="debug-label">Sync phase</span>
              <span className="debug-value">{syncStatus.phase}</span>
            </div>
            <div className="debug-item">
              <span className="debug-label">Replayed</span>
              <span className="debug-value">
                {syncStatus.messagesReplayed}
                {syncStatus.totalMessages
                  ? ` / ${syncStatus.totalMessages}`
                  : ""}
              </span>
            </div>
            <div className="debug-item">
              <span className="debug-label">Snapshot</span>
              <span className="debug-value">
                {syncStatus.snapshotLoaded ? "loaded" : "none"}
              </span>
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
                <span className="debug-value">{ch.tables.join(", ")}</span>
              </div>
            ))}
          </div>
          <div className="debug-actions">
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleSimulateConflict}
              disabled={top.length === 0}
            >
              Simulate conflict
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
