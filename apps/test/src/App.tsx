import { useState, useMemo } from "react";
import { store, useStore } from "@syncengine/client";

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
          <span className="user-tag">{userId}</span>
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
