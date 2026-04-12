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

const STATUS_CLASS: Record<string, string> = {
  live: "ws-live",
  switching: "ws-transition",
  provisioning: "ws-transition",
  connecting: "ws-transition",
  replaying: "ws-replay",
  error: "ws-error",
};

function WorkspaceSwitcher() {
  const s = useStore<DB>();
  const { workspace, workspaces, setWorkspace } = s.use({});
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);

  const handleSwitch = useCallback(async () => {
    if (!input.trim()) return;
    const wsKey = await hashWorkspaceId(input.trim());
    setWorkspace(wsKey);
    setInput("");
    setOpen(false);
  }, [input, setWorkspace]);

  const isTransitioning = workspace.status !== "live" && workspace.status !== "error";

  return (
    <div className="ws-switcher">
      <button
        className={`ws-current ${STATUS_CLASS[workspace.status] ?? ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ws-dot" />
        <span className="ws-id">{workspace.wsKey.slice(0, 10)}</span>
        <span className="ws-status">{isTransitioning ? workspace.status : ""}</span>
        <svg className="ws-chevron" width="10" height="10" viewBox="0 0 10 10">
          <path d="M2.5 3.5L5 6L7.5 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>

      {open && (
        <div className="ws-dropdown">
          {workspaces.length > 0 && (
            <div className="ws-section">
              <div className="ws-section-label">Workspaces</div>
              {workspaces.map((wsKey) => (
                <button
                  key={wsKey}
                  className={`ws-option ${wsKey === workspace.wsKey ? "ws-option-active" : ""}`}
                  onClick={() => { setWorkspace(wsKey); setOpen(false); }}
                >
                  <span className="ws-dot" />
                  <span className="ws-id">{wsKey.slice(0, 16)}</span>
                  {wsKey === workspace.wsKey && <span className="ws-check">&#10003;</span>}
                </button>
              ))}
            </div>
          )}
          <div className="ws-section">
            <div className="ws-section-label">New workspace</div>
            <form className="ws-new" onSubmit={(e) => { e.preventDefault(); handleSwitch(); }}>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="workspace name"
                autoFocus
              />
              <button type="submit" className="btn btn-sm" disabled={!input.trim()}>
                Create
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────

export default function App() {
  const s = useStore<DB>();
  const { ready, workspace } = s.use({ totalSales });

  const userId = useMemo(getUserId, []);
  const [activeTab, setActiveTab] = useState<Tab>("Catalog");

  return (
    <div className="app-shell">
      <div className="app-header">
        <h1>syncengine storefront</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span className="user-tag">{userId}</span>
          <WorkspaceSwitcher />
        </div>
      </div>

      {!ready ? (
        <div style={{ padding: "2rem", color: "#71717a" }}>
          {workspace.status === 'error'
            ? `Error: ${workspace.error ?? 'unknown'}`
            : `${workspace.status === 'live' ? 'Loading' : workspace.status}…`}
        </div>
      ) : (
        <>
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
        </>
      )}

      <footer className="app-footer">
        Open two tabs: <code>?user=alice</code> and <code>?user=bob</code> to
        see live sync and actor contention.
      </footer>
    </div>
  );
}
