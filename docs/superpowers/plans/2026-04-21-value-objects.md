# Value Objects Implementation Plan

> **STATUS:** Draft — plan only, not yet started.

**Goal:** Ship `defineValue()` as the sixth primitive alongside `entity` / `table` / `topic` / `bus` / `workflow`. Branded domain types that extend the existing column DSL with invariants, named factories, and pure-function ops — enforced at every handler boundary and every wire hop.

**Architecture:** A new file `packages/core/src/value.ts` houses `defineValue()`. Scalar form wraps a single `ColumnDef`; composite form groups multiple columns into a JSON-encoded atomic unit. The returned object is callable as a column factory AND acts as a namespace for `.usd(...)`, `.add(...)`, `.zod`, `.equals`, `.is`, `.unsafe`. Brand tracking uses `unique symbol` per value-object name. Schema.ts grows a `'value'` column kind that carries brand metadata; storage delegates to the underlying primitive (`TEXT`/`INTEGER`) for scalars, `TEXT` JSON for composites. Entity runtime + client rebase path + NATS broadcast path all gain rehydration + validation hooks at the column boundary. No vite-plugin discovery — value objects are plain imports.

**Tech Stack:** TypeScript (types + brand symbol), zod (for `.zod` schema derivation — already a framework dep), the existing `ColumnDef` infrastructure in `packages/core/src/schema.ts`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-20-value-objects-design.md`

---

## Architectural decisions (locked before Phase A)

### Composite storage — JSON-in-TEXT, opaque

Composite value objects (Money, Price) are stored as JSON-encoded `TEXT` columns. **The components aren't queryable.** If users need to filter on `amount` or `currency` independently, they either:

1. Use two scalar columns instead of a composite (the "unwrapped" form)
2. Use a scalar value object wrapping the primitive they care about
3. Wait for the `defineValue({ index: [...] })` follow-up if demand materializes

Rationale: a value object is semantically indivisible. Querying on a component is querying on an implementation detail; the API doesn't encourage it. Revisit once we see real demand.

### Rehydration performance — benchmarked at end of Phase C

Every state update that arrives over NATS needs composite value columns re-parsed + re-branded + re-validated. This is on the subscribe hot path.

**Baseline budget:** 10k state updates/sec on a laptop, <10% overhead vs a plain `text()` column carrying the same JSON. If we blow the budget, options are:

1. Skip re-validation on subscribe (trust the server); only re-brand. Ship this if the baseline is close.
2. Memoize invariant results keyed on JSON string identity.
3. Use a faster serialization format (Protobuf/MessagePack) — this is the nuclear option and breaks the "plain JSON everywhere" rule.

Ship option (1) if needed; options (2) and (3) are follow-up work.

### Value-shape migration — same as column rename

Changing a value object's shape (adding a field, renaming, changing the invariant) is a schema migration. The value object's `name` (first arg to `defineValue`) is its identity key; renaming produces a new brand, old data stays serialized in the old shape. Handle via the existing migration system (`packages/core/src/migrations.ts`) when the first incompatible change lands. Not a launch blocker.

### Brand typing — `unique symbol` per name

Each `defineValue('money', ...)` call declares a private `unique symbol` and uses it as the brand property on `T`. Two value objects with the same name ARE the same type (imports resolve to one symbol). Two different names produce incompatible types even if shapes match — that's the point.

### `unsafe()` always available, always loud

`Money.unsafe({ ... })` bypasses validation. Production code should never call it; tests sometimes need invalid states to verify handler rejection. Availability gated at runtime only by naming — no build flags. Document prominently in the guide.

### Scalar vs composite — signature-distinguished

`defineValue(name, text(), opts)` → scalar. `defineValue(name, { a: text(), b: int() }, opts)` → composite. Detection: argument is a `ColumnDef` (has `$kind`) vs a plain object. Locked; no ambiguity.

---

## Phase A — Core primitive (3 tasks)

**Goal:** `defineValue()` runtime + types work end-to-end in isolation — passes unit tests without touching schema/entity/table code.

### A1 — Scalar form with brand + invariant + create + ops
**Files:** new `packages/core/src/value.ts`; test `packages/core/src/__tests__/value.test.ts`.
- Implement `defineValue(name, columnDef)` and `defineValue(name, columnDef, opts)`.
- Brand via `unique symbol`, name-keyed.
- `create.<fn>(raw)` runs invariant, attaches brand.
- Pure-function ops: self-returning detection (runtime shape check), auto-revalidation.
- Passthrough ops (return non-value types like `boolean`, `string`).

### A2 — Composite form
**Files:** extend `value.ts`; extend the test file.
- Accept `{ name: ColumnDef, ... }` as shape argument.
- Shape validation at construction + op boundaries.
- Nesting: composite value containing another value. Inner validation runs first.
- Serialization: `JSON.stringify` of the shape object (brand symbol is invisible, so round-trips cleanly).

### A3 — Full surface — `.zod`, `.equals`, `.is`, `.unsafe`
**Files:** extend `value.ts`; extend tests.
- `.zod` returns `z.ZodType<T>` — shape validation + invariant `.refine()`.
- `.equals(a, b)` deep structural. Recursive for nested values.
- `.is(x)` runtime guard — shape check + invariant. Returns `x is Money.T`.
- `.unsafe(raw)` brands without validation. Tests only; runtime-unguarded (just the naming).

**Exit:** `value.test.ts` covers scalar + composite + nesting + all surface methods. `defineValue` works as a standalone primitive. No integration yet.

---

## Phase B — Schema integration (2 tasks)

**Goal:** Value objects are usable as column factories. Tables and entities type-check `Money()` columns without runtime changes yet.

### B1 — ColumnDef `'value'` kind
**Files:** `packages/core/src/schema.ts`, `packages/core/src/table.ts`.
- Add `'value'` to `ColumnKind` union.
- Extend `ColumnDef` to carry `$brand` (symbol), `$innerKind` (underlying primitive for scalars or `'composite'` for composites), `$invariant` (ref to the validator).
- For scalars: SQLite storage is the inner primitive (`TEXT`/`INTEGER`) — transparent.
- For composites: SQLite storage is `TEXT`, JSON-encoded.

### B2 — Column factory delegation
**Files:** `value.ts`.
- `Money({ default, nullable })` returns a `ColumnDef<Money.T>` with the right metadata.
- `Money()` is shorthand for `Money({})`.
- `Money.T` type alias for handler signatures.

**Exit:** `const total = Money({ default: Money.usd(0) })` type-checks in a `table(...)` or `defineEntity(...)` state block. SQL schema renders correctly (`TEXT` for composites, native for scalars).

---

## Phase C — Entity integration (4 tasks, the biggest phase)

**Goal:** Value objects work end-to-end in entity handlers. Inbound args validated, handler returns validated, state broadcast to clients and rehydrated with brands intact.

### C1 — `EntityStateShape` accepts value defs
**Files:** `packages/core/src/entity.ts` (types only).
- Extend the state shape signature to include `ColumnDef<ValueType>`.
- Type inference: `state.total: Money.T` when `total: Money()` is declared.
- No runtime change — just typing.

### C2 — Handler return validation
**Files:** `packages/core/src/entity.ts` (`applyHandler`), tests.
- After handler runs, walk value-typed columns in the returned state.
- For each, run `.is()` — if fails, throw `EntityError('INVALID_VALUE', ...)` BEFORE any persistence side effects.
- Client-side `rebase()` uses the same path — validation runs on the optimistic update too.

### C3 — Inbound arg validation at the wire
**Files:** `packages/server/src/entity-runtime.ts`.
- Handler signatures declare `Money.T` args; wire sends plain JSON.
- On invocation, walk declared arg types; for each value-typed arg, `.is(rawArg)` and rebrand.
- Reject with `EntityError('INVALID_ARG', ...)` if the invariant fails. Caller sees a 400.

### C4 — Outbound NATS broadcast rehydration
**Files:** `packages/client/src/entity-client.ts` (rehydrate on receive).
- State broadcasts arrive as plain JSON.
- Walk the entity's column map; for every value-typed column, `.is(raw)` + rebrand.
- Trust-server fast-path: if dev flag `SYNCENGINE_VALUE_REBRAND_ONLY=1`, skip `.is()` and just rebrand (benchmark escape).

**Exit:** A demo entity declares `total: Money()`, `customerEmail: Email()`. Handler takes `Money.T`, returns `Money.T`, rejects invalid amounts. Client-side `useEntity` returns state with `Money.T` / `Email.T` branded types, `.format(state.total)` works. Unit tests cover all four boundaries.

**Gate:** Run the benchmark at end of this phase. If <10% overhead vs plain text, proceed. Otherwise ship trust-server re-brand-only as the default.

---

## Phase D — Table integration (2 tasks)

**Goal:** Value objects work in table rows end-to-end. `insert()` effects validate; `useTable` rehydrates.

### D1 — `insert()` effect validates value columns
**Files:** `packages/core/src/entity.ts` (or wherever `normalizeInsert` lives), `packages/server/src/entity-runtime.ts`.
- When an entity handler emits `insert(lineItems, { price })`, validate `price` against `Money`'s invariant.
- Fail fast at emit time, not at persist time — better error location.

### D2 — `useTable` client rehydration
**Files:** `packages/client/src/store.ts`.
- On row arrival, walk value-typed columns; `.is()` + rebrand.
- Composite columns: `JSON.parse` the stored TEXT first.
- Same trust-server escape as C4.

**Exit:** `lineItems.forEach(item => Money.format(item.price))` works end-to-end. Insertion with invalid price throws at emit.

---

## Phase E — Bus integration (1 task, mostly test coverage)

**Goal:** Value objects participate in bus payload validation via `.zod`. Most of the plumbing already works because `.zod` drops into the existing zod-based bus schema.

### E1 — End-to-end test with a value-typed bus payload
**Files:** `packages/core/src/__tests__/bus-values.test.ts`, apps/test kitchen-sink.
- Declare a bus with a schema containing `Money.zod` and `OrderId.zod`.
- Publish with valid payload — subscribers receive branded types.
- Publish with invalid payload — validation rejects at publish time (same mechanism as any other zod schema).
- Bus harness (`createBusTestHarness`) rebrands on dispatch — verify `harness.dispatchedFor(x)[0].payload.total` is `Money.T`, not plain object.

**Exit:** Full round-trip — publish Money on a bus, consumer receives `Money.T` with brand intact, can call `Money.format()` without manual rehydration.

---

## Phase F — Demo + guide (2 tasks)

### F1 — apps/test kitchen-sink demo
**Files:** `apps/test/src/values/money.ts` (new), `apps/test/src/values/ids.ts` (new), edits to `order.actor.ts` + `orders.bus.ts`.
- Define `Money`, `Email`, `OrderId`, `UserId`.
- Order entity uses `total: Money()`, `customerEmail: Email()`, key: `OrderId`.
- Bus payload uses `.zod` schemas throughout.
- Demo includes: invariant rejection (negative amount), ops (`Money.add` across items), cross-type rejection (compile error if you pass `UserId` where `OrderId` is expected).
- Vitest spec demonstrating all of the above.

### F2 — Guide at `docs/guides/value-objects.md`
**Files:** new guide.
- "When to reach for value objects" matrix.
- 5-line minimal example (scalar brand, composite).
- Named factories, invariants, ops.
- Integration with entities / tables / buses.
- Testing with `.unsafe()`.
- Footguns — opaque composite storage, migration path.
- Update `docs/guides/README.md` index.

**Exit:** Guide lives at `docs/guides/value-objects.md`. apps/test vitest + smoke both green.

---

## Verification — exit criteria

1. `pnpm -r test` green.
2. `pnpm -r typecheck` clean.
3. `bash scripts/smoke-docker.sh --buses` passes — apps/test demo uses value objects in entity state, table rows, and bus payloads.
4. Benchmark (end of Phase C): rehydration <10% overhead vs plain `text()` at 10k updates/sec on a laptop. If over budget, trust-server re-brand-only is the default and documented.
5. Unit tests cover: invariant rejection on handler args + returns, ops re-validation, brand-level type safety (compile-error tests), `.zod` schema round-trip, `.equals` / `.is` / `.unsafe`, nesting.
6. Guide at `docs/guides/value-objects.md` cross-links to the spec and shows the apps/test demo.

---

## Out-of-scope (follow-up work)

- **Indexing composite components** — `defineValue({ index: [...] })` or a lowered-column pattern. Wait for demand.
- **Value-object migrations** — formalize the rename / field-add path in the migrations system. Revisit when the first real migration need arises.
- **Custom serialization** — Protobuf / MessagePack. Only if JSON benchmark shows a real bottleneck.
- **Value-object inheritance** — deliberately out. Nest instead.
- **Value objects as entity keys** — keys remain plain strings; a scalar VO can be unwrapped but isn't enforced at the key boundary.
- **Client bundle impact** — audit tree-shaking if the value.ts module grows.

---

## Sequencing notes

Phases A → B → C are sequential (each depends on the prior). Phases D and E can run in parallel after C lands. F runs last.

Task sizing: A1/A2/A3 are ~150 LOC each. B1 is the biggest schema change (~100 LOC touching 3 files). C1/C2/C4 are small (~50 LOC each); C3 is the biggest single file (~150 LOC in entity-runtime). D/E/F are ~50 LOC each.

Total: ~14 tasks, ~1500 LOC, 2–3 working days at the usual cadence.
