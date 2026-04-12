import { useState, useMemo, useCallback } from "react";
import { store, useStore } from "@syncengine/client";
/** Browser-compatible workspace ID hash (mirrors core's hashWorkspaceId). */
async function hashWorkspaceId(id: string): Promise<string> {
  const data = new TextEncoder().encode(id);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}

import {
  products,
  transactions,
  orderIndex,
  salesByProduct,
  recentActivity,
  totalSales,
  allOrders,
  catalogChannel,
  ledgerChannel,
  PRODUCT_SEED,
} from "./schema";

import { CatalogTab } from "./tabs/CatalogTab";
import { OrdersTab } from "./tabs/OrdersTab";
import { CheckoutTab } from "./tabs/CheckoutTab";
import { ActivityTab } from "./tabs/ActivityTab";

// ── Store ────────────────────────────────────────────────────────

export const db = store({
  tables: [products, transactions, orderIndex] as const,
  views: { salesByProduct, recentActivity, totalSales, allOrders },
  channels: [catalogChannel, ledgerChannel],
  seed: { products: PRODUCT_SEED },
});

export type DB = typeof db;

// ── User identity ────────────────────────────────────────────────

function getUserId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("user") ?? "anon";
}

// ── Tab definitions ──────────────────────────────────────────────

const TABS = ["Catalog", "Orders", "Checkout", "Activity"] as const;
type Tab = (typeof TABS)[number];

// ── Workspace Switcher ──────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  live: "#22c55e",
  switching: "#eab308",
  provisioning: "#eab308",
  connecting: "#eab308",
  replaying: "#3b82f6",
  error: "#ef4444",
};

function WorkspaceSwitcher() {
  const s = useStore<DB>();
  const { workspace, setWorkspace } = s.use({ totalSales });
  const [input, setInput] = useState("");

  const handleSwitch = useCallback(async () => {
    if (!input.trim()) return;
    const wsKey = await hashWorkspaceId(input.trim());
    setWorkspace(wsKey);
    setInput("");
  }, [input, setWorkspace]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <span style={{
        background: STATUS_COLORS[workspace.status] ?? "#71717a",
        color: "white",
        padding: "2px 8px",
        borderRadius: "4px",
        fontFamily: "monospace",
        fontSize: "0.75rem",
      }}>
        {workspace.wsKey.slice(0, 8)}{"\u2026"} {workspace.status}
      </span>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSwitch()}
        placeholder="workspace id"
        style={{
          background: "#27272a",
          border: "1px solid #3f3f46",
          borderRadius: "4px",
          color: "#e4e4e7",
          padding: "2px 8px",
          width: "120px",
          fontSize: "0.75rem",
        }}
      />
      <button onClick={handleSwitch} style={{
        background: "#3f3f46",
        border: "none",
        borderRadius: "4px",
        color: "#e4e4e7",
        padding: "2px 8px",
        cursor: "pointer",
        fontSize: "0.75rem",
      }}>Switch</button>
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────

export default function App() {
  const s = useStore<DB>();
  const { ready } = s.useView({ totalSales });

  const userId = useMemo(getUserId, []);
  const [activeTab, setActiveTab] = useState<Tab>("Catalog");

  if (!ready) {
    return (
      <div style={{ padding: "2rem", color: "#71717a" }}>Connecting...</div>
    );
  }

  return (
    <>
      <div className="app-shell">
        <div className="app-header">
          <h1>syncengine storefront</h1>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <WorkspaceSwitcher />
            <span className="user-tag">{userId}</span>
          </div>
        </div>

        <div className="tab-bar" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === "Catalog" && <CatalogTab userId={userId} />}
        {activeTab === "Orders" && <OrdersTab userId={userId} />}
        {activeTab === "Checkout" && <CheckoutTab userId={userId} />}
        {activeTab === "Activity" && <ActivityTab />}

        <footer className="app-footer">
          Open two tabs: <code>?user=alice</code> and <code>?user=bob</code> to
          see live sync and actor contention.
        </footer>
      </div>
    </>
  );
}
