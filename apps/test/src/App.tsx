import { useState, useMemo, useEffect, useRef, memo } from 'react';
import { store, useStore } from '@syncengine/client';

import {
  products, transactions, orderIndex,
  salesByProduct, recentActivity, totalSales, allOrders,
  catalogChannel, ledgerChannel,
  PRODUCT_SEED,
} from './schema';

import { cursorTopic } from './topics/cursors';
import { CursorLayer, type CursorPos } from './CursorLayer';

import { CatalogTab } from './tabs/CatalogTab';
import { OrdersTab } from './tabs/OrdersTab';
import { CheckoutTab } from './tabs/CheckoutTab';
import { ActivityTab } from './tabs/ActivityTab';

// ── Store ────────────────────────────────────────────────────────

export const db = store({
  tables: [products, transactions, orderIndex] as const,
  views: [salesByProduct, recentActivity, totalSales, allOrders],
  channels: [catalogChannel, ledgerChannel],
  seed: { products: PRODUCT_SEED },
});

export type DB = typeof db;

// ── User identity ────────────────────────────────────────────────

function getUserId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('user') ?? 'anon';
}

function randomColor(): string {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 75%, 60%)`;
}

// ── Tab definitions ──────────────────────────────────────────────

const TABS = ['Catalog', 'Orders', 'Checkout', 'Activity'] as const;
type Tab = typeof TABS[number];

// ── App ──────────────────────────────────────────────────────────

export default function App() {
  const s = useStore<DB>();
  const { ready } = s.useView({ totalSales });

  const userId = useMemo(getUserId, []);
  const color = useMemo(randomColor, []);
  const [activeTab, setActiveTab] = useState<Tab>('Catalog');

  // ── Cursors ────────────────────────────────────────────────
  const { peers: cursorPeers, publish: publishCursor, leave: leaveCursor } =
    s.useTopic(cursorTopic, 'global');
  const publishRef = useRef(publishCursor);
  publishRef.current = publishCursor;
  const leaveRef = useRef(leaveCursor);
  leaveRef.current = leaveCursor;

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      publishRef.current({ x: e.clientX, y: e.clientY, color, userId });
    };
    const onMouseLeave = () => { leaveRef.current(); };
    window.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseleave', onMouseLeave);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseleave', onMouseLeave);
      leaveRef.current();
    };
  }, [color, userId]);

  const positions: Record<string, CursorPos> = useMemo(() => {
    const out: Record<string, CursorPos> = {};
    for (const [, data] of cursorPeers) {
      if (data.userId === userId) continue;
      out[data.userId as string] = {
        x: data.x as number, y: data.y as number,
        color: data.color as string, ts: data.$ts,
      };
    }
    return out;
  }, [cursorPeers, userId]);

  const otherCount = Object.keys(positions).length;

  if (!ready) {
    return <div style={{ padding: '2rem', color: '#71717a' }}>Connecting...</div>;
  }

  return (
    <>
      <CursorLayer positions={positions} />
      <div className="app-shell">
        <div className="app-header">
          <h1>syncengine storefront</h1>
          <span className="user-tag">{userId}</span>
          {otherCount > 0 && (
            <span className="user-tag" style={{ color: '#6366f1' }}>
              +{otherCount} live
            </span>
          )}
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

        {activeTab === 'Catalog' && <CatalogTab userId={userId} />}
        {activeTab === 'Orders' && <OrdersTab userId={userId} />}
        {activeTab === 'Checkout' && <CheckoutTab userId={userId} />}
        {activeTab === 'Activity' && <ActivityTab />}

        <footer className="app-footer">
          Open two tabs: <code>?user=alice</code> and <code>?user=bob</code> to
          see live sync and actor contention.
        </footer>
      </div>
    </>
  );
}
