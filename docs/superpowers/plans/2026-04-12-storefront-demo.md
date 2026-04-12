# Storefront Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `apps/test` into a tabbed inventory/storefront demo showcasing 5 actor-model patterns (invariant, state machine, saga, emit, lease).

**Architecture:** Two entities (`inventory`, `order`) backed by Restate actors, three CRDT tables (`products`, `transactions`, `orderIndex`), three DBSP views, and four React tab components. Each tab is `memo()`-wrapped with its own hooks for isolation. Client-side saga coordinates the checkout flow. Existing cursor layer preserved.

**Tech Stack:** `@syncengine/core` (entity, table, view, channel, emit), `@syncengine/client` (store, useEntity, useView, useTopic), React, CSS variables (no component library).

**Spec:** `docs/superpowers/specs/2026-04-12-storefront-demo-design.md`

---

### Task 1: Schema — tables, views, channels, seed data

**Files:**
- Rewrite: `apps/test/src/schema.ts`

- [ ] **Step 1: Replace schema.ts with storefront schema**

```ts
import {
  table, id, real, text, integer, view,
  sum, count, channel,
} from '@syncengine/core';

// ── Domain constants ──────────────────────────────────────────────

export const PRODUCT_SLUGS = [
  'headphones', 'keyboard', 'usb-hub', 'desk-mat', 'webcam', 'monitor-light',
] as const;

export type ProductSlug = typeof PRODUCT_SLUGS[number];

export const TXN_TYPES = ['sale', 'restock'] as const;

export const ORDER_STATUSES = [
  'draft', 'placed', 'packed', 'shipped', 'delivered', 'cancelled',
] as const;

export type OrderStatus = typeof ORDER_STATUSES[number];

// ── Tables ────────────────────────────────────────────────────────

export const products = table('products', {
  id: id(),
  name: text(),
  slug: text({ enum: PRODUCT_SLUGS }),
  price: real(),
  imageEmoji: text(),
});

export const transactions = table('transactions', {
  id: id(),
  productSlug: text({ enum: PRODUCT_SLUGS }),
  userId: text(),
  amount: real(),
  type: text({ enum: TXN_TYPES }),
  timestamp: integer(),
});

export const orderIndex = table('orderIndex', {
  id: id(),
  orderId: text(),
  productSlug: text({ enum: PRODUCT_SLUGS }),
  userId: text(),
  price: real(),
  createdAt: integer(),
});

// ── Views ─────────────────────────────────────────────────────────

export const salesByProduct = view(transactions)
  .filter(transactions.type, 'eq', 'sale')
  .aggregate([transactions.productSlug], {
    total: sum(transactions.amount),
    count: count(),
  });

export const recentActivity = view(transactions)
  .topN(transactions.timestamp, 10, 'desc');

export const totalSales = view(transactions)
  .filter(transactions.type, 'eq', 'sale')
  .aggregate([], {
    revenue: sum(transactions.amount),
    count: count(),
  });

export const allOrders = view(orderIndex).distinct();

// ── Channels ──────────────────────────────────────────────────────

export const catalogChannel = channel('catalog', [products]);
export const ledgerChannel = channel('ledger', [transactions, orderIndex]);

// ── Seed data ─────────────────────────────────────────────────────

export const PRODUCT_SEED = [
  { id: 1, name: 'Wireless Headphones', slug: 'headphones' as const,  price: 79,  imageEmoji: '\u{1F3A7}' },
  { id: 2, name: 'Mechanical Keyboard', slug: 'keyboard' as const,    price: 129, imageEmoji: '\u{2328}\u{FE0F}' },
  { id: 3, name: 'USB-C Hub',           slug: 'usb-hub' as const,     price: 49,  imageEmoji: '\u{1F50C}' },
  { id: 4, name: 'Standing Desk Mat',   slug: 'desk-mat' as const,    price: 35,  imageEmoji: '\u{1F5B1}\u{FE0F}' },
  { id: 5, name: 'Webcam HD',           slug: 'webcam' as const,      price: 65,  imageEmoji: '\u{1F4F7}' },
  { id: 6, name: 'Monitor Light',       slug: 'monitor-light' as const, price: 45, imageEmoji: '\u{1F4A1}' },
] as const;

export const INITIAL_STOCK: Record<ProductSlug, number> = {
  'headphones': 10,
  'keyboard': 8,
  'usb-hub': 15,
  'desk-mat': 12,
  'webcam': 6,
  'monitor-light': 10,
};
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /Users/mk/syncengine && pnpm tsc --noEmit -p apps/test/tsconfig.json 2>&1 | head -20`

Expected: No errors (or only pre-existing unrelated errors).

- [ ] **Step 3: Commit**

```bash
git add apps/test/src/schema.ts
git commit -m "feat(demo): storefront schema — tables, views, channels, seed data"
```

---

### Task 2: Inventory entity

**Files:**
- Create: `apps/test/src/entities/inventory.actor.ts`
- Delete: `apps/test/src/entities/counter.actor.ts`
- Delete: `apps/test/src/entities/account.actor.ts`

- [ ] **Step 1: Create the inventory entity**

```ts
import { entity, integer, text, emit, sourceCount } from '@syncengine/core';
import { transactions } from '../schema';

const STALE_MS = 30_000;

export const inventory = entity('inventory', {
  state: {
    stock: integer(),
    reserved: integer(),
    reservedBy: text(),
    reservedAt: integer(),
  },
  source: {
    totalSold: sourceCount(transactions, transactions.productSlug),
  },
  handlers: {
    restock(state, amount: number) {
      if (amount <= 0) throw new Error('restock amount must be positive');
      return { ...state, stock: state.stock + amount };
    },

    reserve(state, userId: string, now: number) {
      // Release stale reservation first
      let current = state;
      if (current.reservedBy && current.reservedAt > 0 && now - current.reservedAt > STALE_MS) {
        current = { ...current, reserved: current.reserved - 1, reservedBy: '', reservedAt: 0 };
      }

      if (current.reservedBy && current.reservedBy !== userId) {
        throw new Error(`Already reserved by ${current.reservedBy}`);
      }
      if (current.stock - current.reserved <= 0) {
        throw new Error('No stock available to reserve');
      }

      return {
        ...current,
        reserved: current.reserved + 1,
        reservedBy: userId,
        reservedAt: now,
      };
    },

    releaseReservation(state, userId: string) {
      if (state.reservedBy !== userId) {
        throw new Error('You do not hold the reservation');
      }
      return {
        ...state,
        reserved: state.reserved - 1,
        reservedBy: '',
        reservedAt: 0,
      };
    },

    sell(state, userId: string, _orderId: string, price: number, now: number) {
      if (state.reservedBy !== userId) {
        throw new Error('You must hold a reservation to purchase');
      }
      if (state.reservedAt > 0 && now - state.reservedAt > STALE_MS) {
        throw new Error('Reservation has expired');
      }

      const s = state as Record<string, unknown>;
      return emit(
        {
          ...state,
          stock: state.stock - 1,
          reserved: state.reserved - 1,
          reservedBy: '',
          reservedAt: 0,
          totalSold: ((s.totalSold as number) ?? 0) + 1,
        },
        {
          table: 'transactions',
          record: {
            productSlug: '$key',
            userId,
            amount: price,
            type: 'sale',
            timestamp: now,
          },
        },
      );
    },
  },
});
```

- [ ] **Step 2: Remove old entity files**

```bash
rm apps/test/src/entities/counter.actor.ts apps/test/src/entities/account.actor.ts
```

- [ ] **Step 3: Verify compile**

Run: `cd /Users/mk/syncengine && pnpm tsc --noEmit -p apps/test/tsconfig.json 2>&1 | head -20`

Expected: Errors about App.tsx importing deleted entities (expected — fixed in Task 5).

- [ ] **Step 4: Commit**

```bash
git add apps/test/src/entities/
git commit -m "feat(demo): inventory entity — stock, reservations, sell with emit()"
```

---

### Task 3: Order entity

**Files:**
- Create: `apps/test/src/entities/order.actor.ts`

- [ ] **Step 1: Create the order entity**

```ts
import { entity, integer, real, text, emit } from '@syncengine/core';

const STATUSES = ['draft', 'placed', 'packed', 'shipped', 'delivered', 'cancelled'] as const;

const TRANSITIONS: Record<string, string[]> = {
  draft:     ['placed', 'cancelled'],
  placed:    ['packed', 'cancelled'],
  packed:    ['shipped'],
  shipped:   ['delivered'],
  delivered: [],
  cancelled: [],
};

function guardTransition(current: string, next: string): void {
  const allowed = TRANSITIONS[current];
  if (!allowed || !allowed.includes(next)) {
    throw new Error(`Cannot transition from '${current}' to '${next}'`);
  }
}

export const order = entity('order', {
  state: {
    status: text({ enum: STATUSES }),
    productSlug: text(),
    userId: text(),
    price: real(),
    createdAt: integer(),
  },
  handlers: {
    place(state, userId: string, productSlug: string, price: number, now: number) {
      guardTransition(state.status, 'placed');
      return emit(
        {
          ...state,
          status: 'placed' as const,
          userId,
          productSlug,
          price,
          createdAt: now,
        },
        {
          table: 'orderIndex',
          record: {
            orderId: '$key',
            productSlug,
            userId,
            price,
            createdAt: now,
          },
        },
      );
    },

    pack(state) {
      guardTransition(state.status, 'packed');
      return { ...state, status: 'packed' as const };
    },

    ship(state) {
      guardTransition(state.status, 'shipped');
      return { ...state, status: 'shipped' as const };
    },

    deliver(state) {
      guardTransition(state.status, 'delivered');
      return { ...state, status: 'delivered' as const };
    },

    cancel(state) {
      guardTransition(state.status, 'cancelled');
      return { ...state, status: 'cancelled' as const };
    },
  },
});

/** Map a status to its next valid action for the "advance" button. */
export const NEXT_ACTION: Record<string, string | null> = {
  draft: null,      // draft orders need place() with args, not a simple advance
  placed: 'pack',
  packed: 'ship',
  shipped: 'deliver',
  delivered: null,
  cancelled: null,
};

/** Status badge colors. */
export const STATUS_COLORS: Record<string, string> = {
  draft: '#525252',
  placed: '#3b82f6',
  packed: '#eab308',
  shipped: '#a855f7',
  delivered: '#22c55e',
  cancelled: '#ef4444',
};
```

- [ ] **Step 2: Verify compile**

Run: `cd /Users/mk/syncengine && pnpm tsc --noEmit -p apps/test/tsconfig.json 2>&1 | head -20`

Expected: Same App.tsx import errors as before (resolved in Task 5).

- [ ] **Step 3: Commit**

```bash
git add apps/test/src/entities/order.actor.ts
git commit -m "feat(demo): order entity — state machine with guarded transitions"
```

---

### Task 4: CSS — refined dark theme

**Files:**
- Rewrite: `apps/test/src/index.css`

- [ ] **Step 1: Replace index.css with storefront theme**

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; }

:root {
  color-scheme: dark;
  --bg: #09090b;
  --bg-card: #18181b;
  --border: #27272a;
  --fg: #fafafa;
  --muted: #71717a;
  --accent: #6366f1;
  --accent-dim: #4f46e5;
  --green: #22c55e;
  --red: #ef4444;
  --yellow: #eab308;
  --purple: #a855f7;
  --blue: #3b82f6;
  --radius: 8px;
  --mono: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

/* ── Layout ─────────────────────────────────────────────── */

.app-shell {
  max-width: 720px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

.app-header {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  margin-bottom: 2rem;
}

.app-header h1 {
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.app-header .user-tag {
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--muted);
}

/* ── Tabs ───────────────────────────────────────────────── */

.tab-bar {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 1.5rem;
}

.tab-bar button {
  background: none;
  border: none;
  padding: 0.6rem 1rem;
  font-size: 0.85rem;
  color: var(--muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}

.tab-bar button:hover { color: var(--fg); }
.tab-bar button[aria-selected="true"] {
  color: var(--fg);
  border-bottom-color: var(--accent);
}

/* ── Cards ──────────────────────────────────────────────── */

.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0.75rem;
}

.stat-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem 1rem;
}

.stat-card .label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin-bottom: 0.25rem;
}

.stat-card .value {
  font-size: 1.5rem;
  font-weight: 600;
  font-family: var(--mono);
  letter-spacing: -0.02em;
}

/* ── Buttons ────────────────────────────────────────────── */

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.75rem;
  font-size: 0.8rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--fg);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.btn:hover { border-color: var(--muted); }
.btn:active { transform: scale(0.98); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.btn-primary:hover { background: var(--accent-dim); border-color: var(--accent-dim); }

.btn-sm { padding: 0.25rem 0.5rem; font-size: 0.75rem; }

/* ── Pattern badges ─────────────────────────────────────── */

.pattern-badge {
  display: inline-block;
  font-family: var(--mono);
  font-size: 0.65rem;
  padding: 1px 6px;
  border-radius: 4px;
  vertical-align: middle;
  margin-left: 0.5rem;
}

.pattern-badge.invariant  { background: #1e1b4b; color: #818cf8; }
.pattern-badge.emit       { background: #1c1917; color: #eab308; }
.pattern-badge.state-machine { background: #052e16; color: #4ade80; }
.pattern-badge.saga       { background: #1c1917; color: #f87171; }
.pattern-badge.lease      { background: #1e1b4b; color: #a78bfa; }

/* ── Status badges ──────────────────────────────────────── */

.status-badge {
  display: inline-block;
  font-family: var(--mono);
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 4px;
}

/* ── Section headings ───────────────────────────────────── */

.section-heading {
  font-size: 0.95rem;
  font-weight: 600;
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
}

/* ── Product card ───────────────────────────────────────── */

.product-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.product-card .emoji {
  font-size: 1.75rem;
  line-height: 1;
}

.product-card .name {
  font-weight: 500;
  font-size: 0.85rem;
}

.product-card .price {
  font-family: var(--mono);
  font-size: 0.85rem;
  color: var(--muted);
}

.product-card .stock {
  font-size: 0.75rem;
  color: var(--muted);
}

.product-card .stock strong {
  color: var(--fg);
}

/* ── Order list ─────────────────────────────────────────── */

.order-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.order-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.order-row .order-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.order-row .order-product {
  font-size: 0.85rem;
  font-weight: 500;
}

.order-row .order-price {
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--muted);
}

.order-row .order-user {
  font-family: var(--mono);
  font-size: 0.7rem;
  color: var(--accent);
}

/* ── Checkout ───────────────────────────────────────────── */

.checkout-flow {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.timer {
  font-family: var(--mono);
  font-size: 1.25rem;
  color: var(--yellow);
}

.timer.expired { color: var(--red); }

.error-flash {
  font-size: 0.8rem;
  color: var(--red);
  padding: 0.5rem 0.75rem;
  background: #1c1917;
  border: 1px solid #7f1d1d;
  border-radius: var(--radius);
}

/* ── Activity feed ──────────────────────────────────────── */

.activity-feed {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.activity-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--border);
  font-size: 0.8rem;
}

.activity-row .activity-time {
  font-family: var(--mono);
  font-size: 0.7rem;
  color: var(--muted);
  min-width: 5rem;
}

.activity-row .activity-user {
  font-family: var(--mono);
  color: var(--accent);
}

/* ── Footer ─────────────────────────────────────────────── */

.app-footer {
  margin-top: 3rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
  font-size: 0.75rem;
  color: var(--muted);
}

.app-footer code {
  font-family: var(--mono);
  background: var(--bg-card);
  padding: 1px 4px;
  border-radius: 3px;
}

/* ── Select ─────────────────────────────────────────────── */

.select {
  appearance: none;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.4rem 2rem 0.4rem 0.6rem;
  font-size: 0.8rem;
  color: var(--fg);
  cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2371717a' d='M3 4.5l3 3 3-3'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.5rem center;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/test/src/index.css
git commit -m "style(demo): refined dark theme — Vercel-minimal aesthetic"
```

---

### Task 5: App shell — tabs, store, user identity

**Files:**
- Rewrite: `apps/test/src/App.tsx`

- [ ] **Step 1: Replace App.tsx with tabbed shell**

```tsx
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
```

- [ ] **Step 2: Verify compile (will fail — tab components don't exist yet)**

Run: `cd /Users/mk/syncengine && pnpm tsc --noEmit -p apps/test/tsconfig.json 2>&1 | head -20`

Expected: Errors about missing `./tabs/*` imports.

- [ ] **Step 3: Commit**

```bash
git add apps/test/src/App.tsx
git commit -m "feat(demo): app shell — tabbed layout, store wiring, cursor layer"
```

---

### Task 6: Catalog tab

**Files:**
- Create: `apps/test/src/tabs/CatalogTab.tsx`

- [ ] **Step 1: Create CatalogTab**

```tsx
import { memo, useState, useRef, useEffect } from 'react';
import { useStore } from '@syncengine/client';
import type { DB } from '../App';
import { PRODUCT_SEED, INITIAL_STOCK, type ProductSlug } from '../schema';
import { inventory } from '../entities/inventory.actor';

export const CatalogTab = memo(function CatalogTab({ userId }: { userId: string }) {
  return (
    <div>
      <div className="section-heading">
        Products
        <span className="pattern-badge invariant">invariant</span>
        <span className="pattern-badge emit">emit()</span>
      </div>
      <div className="card-grid">
        {PRODUCT_SEED.map((p) => (
          <ProductCard key={p.slug} slug={p.slug} name={p.name} price={p.price} emoji={p.imageEmoji} userId={userId} />
        ))}
      </div>
    </div>
  );
});

const ProductCard = memo(function ProductCard({
  slug, name, price, emoji, userId,
}: {
  slug: ProductSlug; name: string; price: number; emoji: string; userId: string;
}) {
  const s = useStore<DB>();
  const { state, actions, ready } = s.useEntity(inventory, slug);
  const [error, setError] = useState<string | null>(null);

  const st = state as Record<string, unknown> | null;
  const stock = (st?.stock as number) ?? 0;
  const totalSold = (st?.totalSold as number) ?? 0;
  const initialStock = INITIAL_STOCK[slug];
  const seededRef = useRef(false);

  async function handleRestock(amount: number) {
    setError(null);
    try {
      await actions.restock(amount);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  // Auto-seed stock on first use (guarded against StrictMode double-mount)
  useEffect(() => {
    if (ready && stock === 0 && totalSold === 0 && !seededRef.current) {
      seededRef.current = true;
      void handleRestock(initialStock);
    }
  }, [ready, stock, totalSold]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card product-card">
      <div className="emoji">{emoji}</div>
      <div className="name">{name}</div>
      <div className="price">${price}</div>
      <div className="stock">
        {ready ? (
          <>
            <strong>{stock}</strong> in stock
            {totalSold > 0 && <> &middot; {totalSold} sold</>}
          </>
        ) : '...'}
      </div>
      {error && <div className="error-flash">{error}</div>}
      <button type="button" className="btn btn-sm" onClick={() => handleRestock(5)} disabled={!ready}>
        Restock +5
      </button>
    </div>
  );
});
```

- [ ] **Step 2: Verify compile**

Run: `cd /Users/mk/syncengine && pnpm tsc --noEmit -p apps/test/tsconfig.json 2>&1 | head -20`

Expected: Errors about remaining missing tab imports only.

- [ ] **Step 3: Commit**

```bash
git add apps/test/src/tabs/CatalogTab.tsx
git commit -m "feat(demo): catalog tab — product cards with inventory entities"
```

---

### Task 7: Orders tab

**Files:**
- Create: `apps/test/src/tabs/OrdersTab.tsx`

- [ ] **Step 1: Create OrdersTab**

```tsx
import { memo, useState } from 'react';
import { useStore } from '@syncengine/client';
import type { DB } from '../App';
import { allOrders } from '../schema';
import { order, NEXT_ACTION, STATUS_COLORS } from '../entities/order.actor';

export const OrdersTab = memo(function OrdersTab({ userId }: { userId: string }) {
  const s = useStore<DB>();
  const { views } = s.useView({ allOrders });

  const orders = views.allOrders;

  return (
    <div>
      <div className="section-heading">
        Orders
        <span className="pattern-badge state-machine">state-machine</span>
      </div>
      {orders.length === 0 ? (
        <div className="card" style={{ color: '#71717a', textAlign: 'center', padding: '2rem' }}>
          No orders yet. Use the Checkout tab to place one.
        </div>
      ) : (
        <div className="order-list">
          {orders.map((o) => (
            <OrderRow
              key={String(o.orderId)}
              orderId={String(o.orderId)}
              productSlug={String(o.productSlug)}
              orderPrice={Number(o.price)}
              orderUserId={String(o.userId)}
              currentUserId={userId}
            />
          ))}
        </div>
      )}
    </div>
  );
});

const OrderRow = memo(function OrderRow({
  orderId, productSlug, orderPrice, orderUserId, currentUserId,
}: {
  orderId: string; productSlug: string; orderPrice: number;
  orderUserId: string; currentUserId: string;
}) {
  const s = useStore<DB>();
  const { state, actions, ready } = s.useEntity(order, orderId);
  const [error, setError] = useState<string | null>(null);

  const status = state?.status ?? 'draft';
  const nextAction = NEXT_ACTION[status];
  const isOwner = orderUserId === currentUserId;
  const canCancel = status === 'draft' || status === 'placed';

  async function handleAdvance() {
    if (!nextAction) return;
    setError(null);
    try {
      const fn = actions[nextAction as keyof typeof actions] as () => Promise<unknown>;
      await fn();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  async function handleCancel() {
    setError(null);
    try {
      await actions.cancel();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="order-row">
      <div className="order-info">
        <span
          className="status-badge"
          style={{ background: `${STATUS_COLORS[status]}22`, color: STATUS_COLORS[status] }}
        >
          {status}
        </span>
        <span className="order-product">{productSlug}</span>
        <span className="order-price">${orderPrice}</span>
        <span className="order-user">{orderUserId}</span>
      </div>
      {ready && isOwner && nextAction && (
        <button type="button" className="btn btn-sm" onClick={handleAdvance}>
          {nextAction}
        </button>
      )}
      {ready && isOwner && canCancel && (
        <button type="button" className="btn btn-sm" onClick={handleCancel} style={{ color: '#ef4444' }}>
          cancel
        </button>
      )}
      {error && <span className="error-flash" style={{ fontSize: '0.7rem' }}>{error}</span>}
    </div>
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/test/src/tabs/OrdersTab.tsx
git commit -m "feat(demo): orders tab — state machine with guarded transitions"
```

---

### Task 8: Checkout tab

**Files:**
- Create: `apps/test/src/tabs/CheckoutTab.tsx`

- [ ] **Step 1: Create CheckoutTab**

```tsx
import { memo, useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '@syncengine/client';
import type { DB } from '../App';
import { PRODUCT_SEED, type ProductSlug } from '../schema';
import { inventory } from '../entities/inventory.actor';
import { order } from '../entities/order.actor';

const RESERVATION_TTL_MS = 30_000;

export const CheckoutTab = memo(function CheckoutTab({ userId }: { userId: string }) {
  const [selectedSlug, setSelectedSlug] = useState<ProductSlug>(PRODUCT_SEED[0].slug);
  const product = PRODUCT_SEED.find((p) => p.slug === selectedSlug)!;

  return (
    <div>
      <div className="section-heading">
        Checkout
        <span className="pattern-badge saga">saga</span>
        <span className="pattern-badge lease">lease</span>
      </div>
      <div className="checkout-flow">
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <label style={{ fontSize: '0.85rem', color: '#71717a' }}>Product:</label>
          <select
            className="select"
            value={selectedSlug}
            onChange={(e) => setSelectedSlug(e.target.value as ProductSlug)}
          >
            {PRODUCT_SEED.map((p) => (
              <option key={p.slug} value={p.slug}>{p.imageEmoji} {p.name} — ${p.price}</option>
            ))}
          </select>
        </div>
        <CheckoutFlow slug={selectedSlug} price={product.price} userId={userId} />
      </div>
    </div>
  );
});

const CheckoutFlow = memo(function CheckoutFlow({
  slug, price, userId,
}: {
  slug: ProductSlug; price: number; userId: string;
}) {
  const s = useStore<DB>();
  const { state, actions, ready } = s.useEntity(inventory, slug);
  const [error, setError] = useState<string | null>(null);
  const [reservedAt, setReservedAt] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [buying, setBuying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const st = state as Record<string, unknown> | null;
  const stock = (st?.stock as number) ?? 0;
  const reserved = (st?.reserved as number) ?? 0;
  const reservedBy = (st?.reservedBy as string) ?? '';
  const isReservedByMe = reservedBy === userId;
  const available = stock - reserved;

  // Sync reservation state from entity
  useEffect(() => {
    if (isReservedByMe && st?.reservedAt) {
      setReservedAt(st.reservedAt as number);
    } else {
      setReservedAt(null);
    }
  }, [isReservedByMe, st?.reservedAt]);

  // Countdown timer
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!reservedAt) { setTimeLeft(0); return; }

    function tick() {
      const remaining = Math.max(0, RESERVATION_TTL_MS - (Date.now() - reservedAt!));
      setTimeLeft(remaining);
      if (remaining <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        // Auto-release expired reservation
        void actions.releaseReservation(userId).catch(() => {});
        setReservedAt(null);
      }
    }
    tick();
    timerRef.current = setInterval(tick, 100);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [reservedAt, actions, userId]);

  const handleReserve = useCallback(async () => {
    setError(null);
    try {
      await actions.reserve(userId, Date.now());
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }, [actions, userId]);

  const handleRelease = useCallback(async () => {
    setError(null);
    try {
      await actions.releaseReservation(userId);
      setReservedAt(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }, [actions, userId]);

  const handleBuy = useCallback(async () => {
    setError(null);
    setBuying(true);
    const orderId = crypto.randomUUID();
    try {
      // Saga step 1: sell (consumes reservation, emits transaction)
      await actions.sell(userId, orderId, price, Date.now());
      // Saga step 2: place order (creates order entity, emits orderIndex row)
      const orderStore = s.useEntity(order, orderId);
      await orderStore.actions.place(userId, slug, price, Date.now());
      setReservedAt(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBuying(false);
    }
  }, [actions, userId, price, slug, s]);

  const timerSeconds = (timeLeft / 1000).toFixed(1);

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.85rem' }}>
        <span>Stock: <strong>{stock}</strong></span>
        <span style={{ color: '#71717a' }}>Available: <strong>{available}</strong></span>
        {reservedBy && !isReservedByMe && (
          <span style={{ color: '#ef4444' }}>Reserved by {reservedBy}</span>
        )}
      </div>

      {!isReservedByMe ? (
        <button type="button" className="btn btn-primary" onClick={handleReserve} disabled={!ready || available <= 0}>
          Reserve 1 unit
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <span className={`timer${timeLeft <= 5000 ? ' expired' : ''}`}>
              {timerSeconds}s
            </span>
            <span style={{ fontSize: '0.8rem', color: '#71717a' }}>reservation active</span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn btn-primary" onClick={handleBuy} disabled={buying}>
              {buying ? 'Processing...' : `Buy for $${price}`}
            </button>
            <button type="button" className="btn" onClick={handleRelease}>
              Release
            </button>
          </div>
        </>
      )}

      {error && <div className="error-flash">{error}</div>}
    </div>
  );
});
```

**Note:** The `handleBuy` saga calls `s.useEntity(order, orderId)` imperatively. This won't work — `useEntity` is a React hook and can't be called inside a callback. The fix is to use the entity client's `invokeHandler` directly, or to create a non-hook entity action helper. However, looking at the existing codebase, the `actions` proxy on `useEntity` is the only way to call handlers. The workaround: create the order entity subscription eagerly with a known ID, or use `fetch` to the RPC endpoint directly.

Let me revise the buy handler to use a direct RPC call:

```tsx
  const handleBuy = useCallback(async () => {
    setError(null);
    setBuying(true);
    const orderId = crypto.randomUUID();
    try {
      // Saga step 1: sell (consumes reservation, emits transaction)
      await actions.sell(userId, orderId, price, Date.now());
      // Saga step 2: place order via direct RPC (can't useEntity in a callback)
      const res = await fetch(
        `/__syncengine/rpc/order/${encodeURIComponent(orderId)}/place`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify([userId, slug, price, Date.now()]),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      setReservedAt(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBuying(false);
    }
  }, [actions, userId, price, slug]);
```

- [ ] **Step 2: Write the file with the corrected buy handler**

Write the full `CheckoutTab.tsx` as shown above, using the revised `handleBuy` that calls `fetch` for the order entity's `place` handler instead of `useEntity` inside a callback.

- [ ] **Step 3: Commit**

```bash
git add apps/test/src/tabs/CheckoutTab.tsx
git commit -m "feat(demo): checkout tab — reserve/buy saga with TTL countdown"
```

---

### Task 9: Activity tab

**Files:**
- Create: `apps/test/src/tabs/ActivityTab.tsx`

- [ ] **Step 1: Create ActivityTab**

```tsx
import { memo } from 'react';
import { useStore } from '@syncengine/client';
import type { DB } from '../App';
import { totalSales, salesByProduct, recentActivity } from '../schema';

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const ActivityTab = memo(function ActivityTab() {
  const s = useStore<DB>();
  const { views } = s.useView({ totalSales, salesByProduct, recentActivity });

  const stats = views.totalSales[0] ?? { revenue: 0, count: 0 };
  const byProduct = [...views.salesByProduct].sort((a, b) => b.total - a.total);
  const recent = views.recentActivity;

  return (
    <div>
      <div className="section-heading">
        Activity Dashboard
        <span className="pattern-badge emit">emit()</span>
      </div>

      <div className="stat-row">
        <div className="stat-card">
          <div className="label">Revenue</div>
          <div className="value">{fmt(stats.revenue)}</div>
        </div>
        <div className="stat-card">
          <div className="label">Orders</div>
          <div className="value">{stats.count}</div>
        </div>
        <div className="stat-card">
          <div className="label">Avg Order</div>
          <div className="value">{stats.count > 0 ? fmt(stats.revenue / stats.count) : '$0'}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div className="card">
          <div className="section-heading" style={{ fontSize: '0.8rem' }}>Sales by Product</div>
          {byProduct.length === 0 ? (
            <div style={{ color: '#71717a', fontSize: '0.8rem' }}>No sales yet</div>
          ) : (
            byProduct.map((row) => {
              const maxTotal = byProduct[0]?.total ?? 1;
              const pct = (row.total / maxTotal) * 100;
              return (
                <div key={String(row.productSlug)} style={{ marginBottom: '0.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                    <span>{String(row.productSlug)}</span>
                    <span style={{ fontFamily: 'var(--mono)', color: '#71717a' }}>{fmt(row.total)} ({row.count})</span>
                  </div>
                  <div style={{ background: '#27272a', borderRadius: '2px', height: '4px' }}>
                    <div style={{ background: '#6366f1', borderRadius: '2px', height: '4px', width: `${pct}%` }} />
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="card">
          <div className="section-heading" style={{ fontSize: '0.8rem' }}>Recent Activity</div>
          {recent.length === 0 ? (
            <div style={{ color: '#71717a', fontSize: '0.8rem' }}>No transactions yet</div>
          ) : (
            <div className="activity-feed">
              {recent.map((txn) => {
                const time = new Date(Number(txn.timestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                return (
                  <div key={String(txn.id)} className="activity-row">
                    <span className="activity-time">{time}</span>
                    <span className="activity-user">{String(txn.userId)}</span>
                    <span>{String(txn.type)}</span>
                    <span style={{ fontFamily: 'var(--mono)' }}>{String(txn.productSlug)}</span>
                    <span style={{ fontFamily: 'var(--mono)', marginLeft: 'auto' }}>{fmt(Number(txn.amount))}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Verify full compile**

Run: `cd /Users/mk/syncengine && pnpm tsc --noEmit -p apps/test/tsconfig.json 2>&1 | head -30`

Expected: Clean compile (all imports resolved).

- [ ] **Step 3: Commit**

```bash
git add apps/test/src/tabs/ActivityTab.tsx
git commit -m "feat(demo): activity tab — DBSP dashboard with live views"
```

---

### Task 10: Smoke test

**Files:** None (manual verification)

- [ ] **Step 1: Start the dev server**

Run: `cd /Users/mk/syncengine && pnpm dev`

Expected: Vite dev server starts, NATS and Restate boot, no errors.

- [ ] **Step 2: Open two browser tabs**

Open `http://localhost:5173/?user=alice` and `http://localhost:5173/?user=bob`.

Expected: Both tabs show the storefront with the Catalog tab active. Product cards show stock levels. Cursors are visible across tabs.

- [ ] **Step 3: Test catalog — restock**

In Alice's tab, click "Restock +5" on Headphones.

Expected: Stock increases to 15 in Alice's tab and Bob's tab within ~100ms.

- [ ] **Step 4: Test checkout — reserve + buy**

In Alice's tab, switch to Checkout, select Headphones, click "Reserve 1 unit."

Expected: Countdown timer appears. Bob tries to reserve the same product → gets "Already reserved by alice" error.

Alice clicks "Buy for $79."

Expected: Order appears in Orders tab (both tabs). Transaction appears in Activity tab. Stock decreases by 1.

- [ ] **Step 5: Test orders — state machine**

In Alice's tab, switch to Orders. Click "pack" on the new order.

Expected: Status changes from "placed" to "packed." Bob can see the change. Try clicking "pack" again → error.

- [ ] **Step 6: Fix any issues found during smoke test**

Address compile errors, runtime errors, or visual issues.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "fix(demo): smoke test fixes"
```
