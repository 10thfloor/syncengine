# Storefront Demo — Actor Pattern Showcase

**Date:** 2026-04-12
**Status:** Draft
**Target:** `apps/test`

## Goal

Refactor the test app into a polished, tabbed inventory/storefront demo that showcases five actor-model patterns in a single cohesive scenario. Primary audience: framework evaluators comparing syncengine to Meteor/Convex/Liveblocks. Secondary: adopters learning patterns they can copy.

The demo should make someone say *"oh, I can't do this easily in Meteor/Convex"* — specifically around single-writer invariants, actor-to-table bridging, sagas, and state machines.

## Design Constraints

- **Visual:** Clean, dark, minimal — Vercel aesthetic. CSS variables + utility classes. No component library (no Tailwind, no shadcn). Monospace accents, generous whitespace, subtle borders, zinc tones with one accent color.
- **Multi-user:** Same view, different users via `?user=alice` / `?user=bob` URL params. Both see the same storefront; actions from one tab appear live in the other.
- **Performance:** One `memo()`-wrapped component per tab. Each tab owns its hooks. No cross-tab re-renders.
- **Keep:** Live collaborative cursors (CursorLayer + cursorTopic) from the existing test app.

## Actor Patterns Showcased

| Pattern | Description | Where |
|---|---|---|
| **Invariant enforcement** | Actor rejects invalid state transitions | Catalog (can't oversell), Checkout (can't reserve if none left) |
| **State machine** | Explicit states with guarded transitions | Orders (draft → placed → packed → shipped → delivered) |
| **Saga** | Multi-step coordinated mutation across actors | Checkout (reserve → sell → create order, or rollback) |
| **Actor-to-table bridge (emit)** | Entity writes rows into CRDT tables | Inventory sell/restock → transactions table |
| **Distributed lease** | Time-limited exclusive reservation with TTL | Checkout (reserve stock with countdown) |

## Entities

### `inventory` entity

Keyed by product slug (e.g., `"headphones"`).

**State:**
- `stock: integer()` — available units
- `reserved: integer()` — units currently held by reservations
- `reservedBy: text()` — userId holding the reservation (empty string = none)
- `reservedAt: integer()` — timestamp of reservation (0 = none)

**Source projections:**
- `totalSold: sourceCount(transactions, transactions.productSlug)` — lifetime sales count derived from the transactions table

**Handlers:**
- `restock(amount: number)` — adds stock. Invariant: amount > 0.
- `reserve(userId: string, now: number)` — claims 1 unit with TTL. Fails if `stock - reserved <= 0`. If an existing reservation is stale (>30s), it's released first. Sets `reservedBy`, `reservedAt`, increments `reserved`.
- `releaseReservation(userId: string)` — cancels reservation. Decrements `reserved`, clears `reservedBy`/`reservedAt`. Fails if caller isn't the reservation holder.
- `sell(userId: string, orderId: string, price: number, now: number)` — consumes a reservation. Decrements `stock` and `reserved`, clears reservation fields. `emit()`s a transaction row `{ productSlug: '$key', userId, amount: price, type: 'sale', timestamp: now }`. Fails if caller doesn't hold the reservation. Price is passed as an arg (looked up from the products table by the caller) to keep the handler pure.

### `order` entity

Keyed by order ID (generated client-side, e.g., `crypto.randomUUID()`).

**State:**
- `status: text({ enum: STATUSES })` — one of `draft`, `placed`, `packed`, `shipped`, `delivered`, `cancelled`
- `productSlug: text()`
- `userId: text()`
- `price: real()`
- `createdAt: integer()`

**Handlers:**
- `place(userId, productSlug, price, now)` — only from `draft` (initial state). Sets all fields, transitions to `placed`.
- `pack()` — only from `placed` → `packed`.
- `ship()` — only from `packed` → `shipped`.
- `deliver()` — only from `shipped` → `delivered`.
- `cancel()` — only from `draft` or `placed` → `cancelled`.

Each handler throws on invalid transition. The entity's initial state has `status: 'draft'`.

## Tables

### `products`

Catalog data, freely replicated via CRDT.

| Column | Type | Notes |
|---|---|---|
| `id` | `id()` | Auto-assigned |
| `name` | `text()` | Product display name |
| `slug` | `text()` | URL-safe key, matches inventory entity key |
| `price` | `real()` | Dollar amount |
| `imageEmoji` | `text()` | Emoji stand-in for product image |

Seed data: 4-6 products (e.g., Wireless Headphones, Mechanical Keyboard, USB-C Hub, Standing Desk Mat, Webcam, Monitor Light).

### `transactions`

Ledger rows. **Never written directly** — only populated via `emit()` from the inventory entity.

| Column | Type | Notes |
|---|---|---|
| `id` | `id()` | Auto-assigned |
| `productSlug` | `text()` | Which product |
| `userId` | `text()` | Who acted |
| `amount` | `real()` | Dollar amount (positive for sales, could extend for restocks) |
| `type` | `text({ enum: ['sale', 'restock'] })` | Transaction type |
| `timestamp` | `integer()` | Unix ms |

### `orderIndex`

Order registry. Populated via `emit()` from the order entity's `place()` handler.

| Column | Type | Notes |
|---|---|---|
| `id` | `id()` | Auto-assigned |
| `orderId` | `text()` | Entity key for the order |
| `productSlug` | `text()` | Which product |
| `userId` | `text()` | Who placed it |
| `price` | `real()` | Order amount |
| `createdAt` | `integer()` | Unix ms |

## Views (DBSP)

- **`salesByProduct`** — `view(transactions).filter(type === 'sale').aggregate([productSlug], { total: sum(amount), count: count() })`
- **`recentActivity`** — `view(transactions).topN(timestamp, 10, 'desc')`
- **`totalSales`** — `view(transactions).filter(type === 'sale').aggregate([], { revenue: sum(amount), count: count() })`

## Channels

- **`catalog`** — groups `products` table
- **`ledger`** — groups `transactions` table

Separate channels so catalog edits don't replay with high-frequency transaction traffic.

## Tab Design

### Catalog Tab

**Patterns:** `invariant` `emit()`

Product cards in a grid. Each card shows:
- Emoji + name + price
- Stock level (from inventory entity state)
- Lifetime sales count (from source projection `totalSold`)
- "Restock +5" button

Stock updates appear live across tabs. Clicking restock on a product with 0 stock shows the invariant in action (restock succeeds, but you can't sell below 0).

Each product card uses `useEntity(inventory, slug)` — one entity subscription per product.

### Orders Tab

**Pattern:** `state-machine`

List of the current user's orders (filtered client-side by userId). Each order shows:
- Product name + price
- Colored status badge (draft=gray, placed=blue, packed=yellow, shipped=purple, delivered=green, cancelled=red)
- "Next" button to advance to the next valid state
- "Cancel" button (visible only when cancellation is valid)

Clicking "Next" on a `draft` order calls `place()`, on `placed` calls `pack()`, etc. Invalid transitions show a brief error flash. Orders from other users appear in the list too (shared state) but only the owning user can advance them.

Each order uses `useEntity(order, orderId)`. The list of order IDs is maintained in a CRDT table or derived from transactions — TBD on exact mechanism, likely a simple `orders` metadata table or client-side tracking.

**Order ID tracking:** The order entity is keyed by ID, but we need to know *which* order IDs exist. The `order.place()` handler uses `emit()` to insert a row into a lightweight `orderIndex` CRDT table (`{ orderId, productSlug, userId, price, status, createdAt }`). The Orders tab renders a DBSP view over `orderIndex` to list all orders, then uses `useEntity(order, orderId)` per row for live state. This also means the `orderIndex` table is another demonstration of the actor-to-table bridge.

### Checkout Tab

**Patterns:** `saga` `lease`

Two-phase purchase flow:

1. **Pick a product** — dropdown or card selection from the catalog.
2. **Reserve** — "Reserve" button calls `inventory.reserve(userId, now)`. On success, a countdown timer appears (30s TTL). If stock is 0 or already reserved by someone else, shows contention error.
3. **Buy** — while reservation is active, "Complete Purchase" button triggers the saga:
   - Call `inventory.sell(userId, orderId, now)` — consumes reservation, emits transaction
   - Call `order.place(userId, productSlug, price, now)` — creates the order
   - If sell fails (reservation expired), show error, don't create order
4. **Expiry** — if the countdown hits 0, call `inventory.releaseReservation(userId)` to return stock.

The saga is orchestrated client-side (the checkout component coordinates the two entity calls in sequence). This is a pragmatic choice — a server-side saga would require Restate workflow orchestration which is a Phase 6+ feature. The client-side saga still demonstrates the pattern: multi-step coordination with rollback-on-failure semantics.

The countdown timer is a local `setInterval` that calls release when it expires. The inventory entity's `sell()` handler independently validates that the reservation hasn't expired (server-authoritative TTL check), so even if the timer is slightly off, the server rejects stale reservations.

### Activity Tab

**Patterns:** DBSP views (read-only)

Dashboard with three cards:
- **Total Revenue** — from `totalSales` view (big number + count)
- **Sales by Product** — from `salesByProduct` view (list with bars or simple table)
- **Recent Activity** — from `recentActivity` view (feed of latest transactions with timestamp, user, product, amount)

All update live as transactions flow in from other tabs. This tab has no entity hooks — just `useView()`. It proves the actor→table→view pipeline: inventory actor `emit()`s rows, DBSP incrementally recomputes, React re-renders.

## File Structure

```
apps/test/src/
├── schema.ts                    # products, transactions, orderIndex tables + views + channels + seed data
├── entities/
│   ├── inventory.actor.ts       # stock, reservation, sell, restock
│   └── order.actor.ts           # state machine lifecycle
├── topics/
│   └── cursors.ts               # keep existing live cursors
├── tabs/
│   ├── CatalogTab.tsx           # product cards + restock
│   ├── OrdersTab.tsx            # order list + state transitions
│   ├── CheckoutTab.tsx          # reserve + buy saga
│   └── ActivityTab.tsx          # DBSP dashboard
├── CursorLayer.tsx              # keep existing (unchanged)
├── App.tsx                      # thin shell: tab bar + cursor layer + user identity
├── index.css                    # refined dark theme, Vercel-minimal aesthetic
└── main.tsx                     # keep existing (unchanged)
```

## Seed Data

Products seeded at store creation:

| Name | Slug | Price | Emoji | Initial Stock |
|---|---|---|---|---|
| Wireless Headphones | `headphones` | $79 | 🎧 | 10 |
| Mechanical Keyboard | `keyboard` | $129 | ⌨️ | 8 |
| USB-C Hub | `usb-hub` | $49 | 🔌 | 15 |
| Standing Desk Mat | `desk-mat` | $35 | 🖱️ | 12 |
| Webcam HD | `webcam` | $65 | 📷 | 6 |
| Monitor Light | `monitor-light` | $45 | 💡 | 10 |

Initial stock is set by running `inventory.restock()` on first load (or by seeding the entity state). Since entities are Restate-backed, seed data for entities works differently than table seeds — the first `_read` returns `$initialState` (stock=0), and the app calls `restock` once if stock is 0. This is a natural pattern: "initialize on first use."

## What We're NOT Building

- Server-side saga orchestration (requires Restate workflow, Phase 6+)
- Real product images (emoji stand-ins are fine for a demo)
- Authentication or authorization (userId from URL param)
- Responsive/mobile layout
- Routing (tabs are React state, not URL routes)
- Payment processing simulation (sell is the terminal action)

## Success Criteria

1. Open two tabs with `?user=alice` and `?user=bob`
2. Alice restocks headphones → Bob sees stock increase live
3. Alice reserves the last headphone → Bob tries to reserve → gets contention error
4. Alice completes purchase → order appears in Orders tab, transaction appears in Activity tab for both users
5. Bob advances an order through the state machine → invalid transitions are rejected
6. Activity dashboard updates incrementally as transactions flow in
7. All of the above with <100ms perceived latency (latency compensation)
