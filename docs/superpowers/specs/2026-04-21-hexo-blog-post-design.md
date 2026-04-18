# Hexo Blog Post — Introduction Tutorial

> "Show don't tell" intro to the framework, branded as **Hexo**.

## Format

**Terminal walkthrough** — the entire post is a guided session. Terminal commands, file edits, and running output. Commentary is minimal and inline. The reader follows along and builds something real. The output *is* the pitch.

## Deliverable

A single standalone HTML page (`apps/hexo-blog/index.html`) that looks and feels like a polished dark-mode blog post. No external dependencies beyond Google Fonts. Self-contained CSS, syntax-highlighted code blocks, and the terminal aesthetic established in the brainstorming mockups.

## Visual Design

- **Dark mode** — `#0a0a0a` background, zinc palette
- **Typography** — Inter for prose, JetBrains Mono for code
- **Code blocks** — dark cards with syntax highlighting (purple keywords, blue functions, green strings, yellow numbers, dim comments)
- **Section markers** — colored numbered circles on a vertical timeline, each color mapping to an onion ring
- **Terminal blocks** — fake terminal chrome (dots, title bar) for shell sessions
- **Onion diagram** — concentric rings at the top and again in the payoff section, showing how primitives map to architecture layers

## Structure

### Section 0 — Cold Open (The Hook)

No title. No explanation. A terminal session:

```
$ npx create-hexo my-shop
$ cd my-shop && hexo dev
  restate   ready
  nats      connected
  vite      http://localhost:5173
```

Then a prose line: *"Open two tabs. Click 'buy' in one. The other tab updates instantly. No polling. No websocket code. No state management."*

The reader's brain goes "wait, how?" — and we spend the rest of the post answering.

### Section 1 — Schema (The Domain Model)

**Color:** pink (`#f472b6`)
**Onion ring:** center

Show `table()`, `text()`, `integer()`, `real()`, `id()`. Two tables: `products` and `transactions`. The code is the explanation — comments note "no ORM, no migrations, no connection string."

**Reveal:** Schema is the center of the onion — pure data, zero behavior.

### Section 2 — Entity (The Atom)

**Color:** indigo (`#818cf8`)
**Onion ring:** core logic

Show the `inventory` entity with `stock` and `reserved` state, a `restock` handler. Comment: `// One instance per product, keyed by slug`. The handler is a pure function returning spread state.

**Reveal:** Handlers are pure. No async, no ctx, no side effects.

### Section 3 — Emit (Declarative Effects)

**Color:** violet (`#c084fc`)
**Onion ring:** core logic

Show the `sell` handler using `emit({ state, effects: [insert(transactions, ...)] })`. Import `transactions` from step 1 with a `← from step 1` comment.

**Reveal:** `insert()` references the schema table — fully typed, no string names.

### Section 4 — View (Derived Data)

**Color:** green (`#86efac`)
**Onion ring:** derived + client

Show `view(transactions).filter(...).aggregate(...)` producing `salesByProduct`. Comments: "no re-query, no cache invalidation, deltas not re-scans."

**Reveal:** DBSP incremental computation — views reference the same schema columns.

### Section 5 — useEntity + useView (The UI Layer)

**Color:** sky (`#38bdf8`)
**Onion ring:** derived + client

Show `db.useEntity(inventory, 'keyboard')` and `db.useView({ salesByProduct })`, then `await actions.sell(...)`. Comments explain optimistic update: "state.stock is already 9, server confirms in background."

**Reveal:** Same handler runs client-side (optimistic) then server-side (authoritative).

### Section 6 — Bus (Decoupling)

**Color:** yellow (`#facc15`)
**Onion ring:** orchestration

Show `bus()` definition with Zod schema, then the `sell()` handler again but now with both `insert()` and `publish()` in the same effects array. Comments note atomicity: "both effects execute atomically — the runtime journals each one. If one fails, the handler replays. No partial state." And decoupling: "who listens? The entity doesn't care."

**Reveal:** Effects are atomic. `insert()` and `publish()` are the same pattern.

### Section 7 — Workflow (Orchestration)

**Color:** orange (`#f97316`)
**Onion ring:** orchestration

Show `defineWorkflow` with `on(orderEvents).where(...)`, two services (`shipping`, `email`), and a multi-step body: ship → notify → `ctx.sleep(days(3))` → review email. Comments explain durability: "each await is a durable checkpoint, retry starts at step 2 not step 1, sleep pauses for 3 real days, DLQ after retries."

**Reveal:** `ctx.sleep(days(3))` pauses the workflow for 3 days — it's not setTimeout, it's durable.

### Section 8 — Service (The Boundary)

**Color:** red (`#ef4444`)
**Onion ring:** external world

Show `service('shipping', { ... })` with a `create` method. Comments note the swap: "in tests: mock. In prod: real adapter. The workflow code never changes."

**Reveal:** The outermost ring — everything inside is pure, typed, and independently testable.

### Section 9 — Zoom Out (The Payoff)

**Color:** violet (`#a78bfa`)

Prose: "You just built a hexagonal architecture. Schema at the center. Services at the edge. Every layer is pure, typed, and knows nothing about the layers outside it."

Show the ASCII onion diagram with colored rings labeling each layer. Optionally re-render the concentric circles diagram from the top.

## Color → Ring Mapping

| Ring | Sections | Color | Hex |
|------|----------|-------|-----|
| Domain model | 1 (Schema) | pink | `#f472b6` |
| Core logic | 2 (Entity), 3 (Emit) | indigo/violet | `#818cf8` / `#c084fc` |
| Derived + client | 4 (View), 5 (Hooks) | green/sky | `#86efac` / `#38bdf8` |
| Orchestration | 6 (Bus), 7 (Workflow) | yellow/orange | `#facc15` / `#f97316` |
| External world | 8 (Service) | red | `#ef4444` |

## Code API Requirements

All code examples must use the **current** framework API:

- `emit({ state, effects: [...] })` — NOT the legacy `emit(state, { table, record })` form
- `insert(tableRef, record)` — typed insert helper
- `publish(busRef, payload)` — typed publish helper
- `defineWorkflow` with `on(bus).where(...)`, `services: [...]`, `Retry.exponential(...)`
- `service('name', { methods })` — hexagonal port declaration
- `entity()` / `defineEntity()` with `state`, `handlers`
- `view(table).filter(...).aggregate(...)` for materialized views
- `db.useEntity(def, key)` and `db.useView({ ...views })` for client hooks

## Non-Goals

- Not a real tutorial with runnable code — it's a blog post that *reads like* a terminal session
- No framework internals (Restate, NATS, DBSP) mentioned by name — they're implementation details
- No installation instructions or dependency lists
- No comparison to other frameworks
