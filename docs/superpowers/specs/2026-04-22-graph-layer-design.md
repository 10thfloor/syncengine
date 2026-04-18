# Graph Layer for syncengine

**Date:** 2026-04-22
**Status:** Draft

## Context

syncengine's schema model is relational — `table()`, `view()`, `entity()` compose around rows and joins. Graph-shaped domains (social follows, tagging, comment threads, org reporting structures, permission chains) are expressible but awkward: every graph traversal becomes a manual join-table query, every hierarchy a recursive SQL exercise, every "friends of friends" a multi-line view composition.

The framework already has the storage primitives (CRDT-replicated tables), the incremental compute primitives (DBSP views via `dbsp-engine`), the sync primitives (channels, NATS broadcasts), and the actor primitives (Restate-backed entities). What's missing is a **thin, typed graph-modeling layer** that sits on top of all of them — so the developer can say *"a user follows a user"* and the framework handles the storage, the typed traversal API, the reactive hooks, and the cardinality.

**Pain points in the status quo:**

1. **Graph shapes are untyped join tables** — `follows(followerId, followeeId)` is just another `table()`. Traversals are `view().join()` chains with no graph vocabulary.
2. **Recursive queries are impossible** — the existing `Operator` union (`filter | project | topN | aggregate | distinct | join`) has no fixpoint primitive. Comment threads, transitive permissions, and reachability cannot be computed incrementally.
3. **Cardinality is convention, not contract** — a "one-to-many" relationship is enforced by application code, not by types. `.author[0]` leaks when the underlying model semantically has one author.
4. **Entities don't carry their relationships** — `useEntity(user, id)` gives you `state`, but neighbors require separate `useView()` calls with manual joins.

**Approach:** a single new primitive, `edge()`, that compiles to a synthesized CRDT-replicated table and hangs graph-flavored methods off the returned reference. Edges are typed by source / target / cardinality. Entity definitions gain an `edges:` block that exposes neighbors directly on `useEntity`. The DBSP engine gains a `recursive` operator that powers transitive closure, ancestor/descendant queries, and shortest-path. One convenience constructor, `hierarchy()`, wraps the common self-edge-with-tree-semantics case.

Scope is **modeling convenience**, not a graph database. No Cypher-style DSL. Composition is via chaining the view-builder methods edges return.

---

## 1. `edge()` API

### 1.1 Declaration

```ts
import { edge, Cardinality, real, integer } from '@syncengine/core';
import { users, posts, tags, products } from './schema';

// Many-to-many (default cardinality — common case needs no options)
export const follows = edge('follows', users, users);

// One-to-many
export const authored = edge('authored', users, posts, {
  cardinality: Cardinality.OneToMany,
});

// Many-to-one
export const reportsTo = edge('reportsTo', users, users, {
  cardinality: Cardinality.ManyToOne,
});

// With edge properties
export const tagged = edge('tagged', products, tags, {
  cardinality: Cardinality.ManyToMany,
  props: {
    weight: real(),
    addedAt: integer(),
  },
});
```

### 1.2 Signature

```ts
function edge<
  TName extends string,
  TFrom extends AnyTable,
  TTo extends AnyTable,
  TCard extends Cardinality = Cardinality.ManyToMany,
  TProps extends Record<string, ColumnDef<unknown>> = {},
>(
  name: TName,
  fromTable: TFrom,
  toTable: TTo,
  options?: {
    cardinality?: TCard;
    props?: TProps;
    allowDuplicates?: boolean;  // default false — (from, to) is unique
  },
): EdgeDef<TName, TFrom, TTo, TCard, TProps>;
```

### 1.3 Cardinality constants

Mirrors the `Access.*` pattern — no magic strings.

```ts
export const Cardinality = {
  OneToOne: 'OneToOne',
  OneToMany: 'OneToMany',
  ManyToOne: 'ManyToOne',
  ManyToMany: 'ManyToMany',
} as const;

export type Cardinality = typeof Cardinality[keyof typeof Cardinality];
```

Default is `ManyToMany` — no-constraint, the permissive case.

### 1.4 Backing table

Each edge compiles to a synthesized `Table`:

| Form | Synthesized columns |
|------|---------------------|
| No props | `id: id(), from: text(), to: text()` |
| With props | `id: id(), from: text(), to: text(), ...props` |

The backing table is accessible as `edge.$table` and is registerable in channels and views like any other table.

**Table naming:** edges use the edge name directly as the table name. An `edge('follows', …)` produces a `follows` table. Users must not declare a separate `table('follows', …)` — the framework throws at registration time if the names collide.

**Primary key:** always a synthetic `id()`. This allows prop-carrying edges to have multiple rows between the same pair without composite-key collisions.

**Uniqueness:**
- By default, `(from, to)` is enforced unique at `link()` time (framework throws on duplicate).
- `allowDuplicates: true` disables the check — appropriate for time-series edges like `viewed`, `clicked`, or when the props themselves discriminate (multiple `tagged` with distinct `addedAt`).

**Cardinality enforcement (runtime):**
- `OneToOne` — unique on `from` AND unique on `to`
- `OneToMany` — unique on `to` (each target has one source)
- `ManyToOne` — unique on `from` (each source has one target)
- `ManyToMany` — no cardinality constraint (only the `(from, to)` uniqueness unless `allowDuplicates`)

Violation throws `EdgeCardinalityViolation` (framework error, not domain).

---

## 2. `hierarchy()` API

Sugar constructor for self-edges with tree semantics. Expands to an `edge()` plus tree-specific methods.

```ts
export const commentTree = hierarchy('commentTree', comments);

// With props (ordered children, for example):
export const menuTree = hierarchy('menuTree', menuItems, {
  props: { order: integer() },
});
```

Equivalent to:

```ts
edge('commentTree', comments, comments, {
  cardinality: Cardinality.ManyToOne,  // each node has one parent
  props: { ... },
});
```

...but with additional methods (`.ancestors`, `.descendants`, `.root`, `.depth`, etc.) hung off the returned reference. See section 6.

---

## 3. Return Shape of `edge()`

```ts
interface EdgeDef<
  TName extends string,
  TFrom extends AnyTable,
  TTo extends AnyTable,
  TCard extends Cardinality,
  TProps extends Record<string, ColumnDef<unknown>>,
> {
  readonly $tag: 'edge';
  readonly $name: TName;
  readonly $from: TFrom;
  readonly $to: TTo;
  readonly $cardinality: TCard;
  readonly $props: TProps;
  readonly $table: Table<TName, EdgeColumns<TFrom, TTo, TProps>>;

  // ── One-hop traversal ────────────────────────────────────────
  outgoing(fromId: string): ViewBuilder<TTo['$record']>;
  incoming(toId: string): ViewBuilder<TFrom['$record']>;
  connected(id: string): ViewBuilder<TFrom['$record'] | TTo['$record']>;

  // ── Recursive traversal (requires fixpoint — see §7) ─────────
  reachable(fromId: string, opts?: TraversalOpts): ViewBuilder<TTo['$record']>;
  reachableFrom(toId: string, opts?: TraversalOpts): ViewBuilder<TFrom['$record']>;
  pathTo(fromId: string, toId: string, opts?: TraversalOpts): ViewBuilder<PathRecord>;

  // ── Set operations on neighbor sets ──────────────────────────
  commonNeighbors(a: string, b: string): ViewBuilder<TTo['$record']>;
}

interface TraversalOpts {
  /** Maximum fixpoint iterations. Default 64; hard cap at 1024. */
  maxDepth?: number;
}

interface PathRecord {
  from: string;
  to: string;
  path: readonly string[];  // node ids in order
  depth: number;
}
```

`HierarchyDef` extends `EdgeDef` with tree methods — see §6.

---

## 4. Cardinality-aware Types

The entity-side descriptors `outgoing(edge)` and `incoming(edge)` return typed descriptors. Return shape follows cardinality + direction:

```ts
type EdgeResult<E extends AnyEdge, D extends 'outgoing' | 'incoming'> =
  D extends 'outgoing'
    ? E['$cardinality'] extends 'OneToOne' | 'ManyToOne'
      ? E['$to']['$record'] | null
      : readonly E['$to']['$record'][]
    : E['$cardinality'] extends 'OneToOne' | 'OneToMany'
      ? E['$from']['$record'] | null
      : readonly E['$from']['$record'][];
```

Worked examples:

| Edge | Direction | Result type |
|------|-----------|-------------|
| `follows: users ⟶ users` (M:N) | `outgoing` | `User[]` |
| `follows: users ⟶ users` (M:N) | `incoming` | `User[]` |
| `authored: users ⟶ posts` (1:N) | `outgoing` (from user) | `Post[]` |
| `authored: users ⟶ posts` (1:N) | `incoming` (from post) | `User \| null` |
| `reportsTo: users ⟶ users` (N:1) | `outgoing` | `User \| null` |
| `reportsTo: users ⟶ users` (N:1) | `incoming` | `User[]` |

The "`| null`" applies when the single-side neighbor may be absent (e.g., a root user with no manager). Callers always narrow before access.

---

## 5. Integration with Entity — `edges:` Block

### 5.1 Declaration

```ts
import { entity, text, outgoing, incoming, emit, link, unlink, sourceCount } from '@syncengine/core';
import { follows, authored, reportsTo } from '../schema';

export const user = entity('user', {
  state: {
    name: text(),
    avatar: text(),
  },

  source: {
    followerCount:  sourceCount(incoming(follows)),
    followingCount: sourceCount(outgoing(follows)),
  },

  edges: {
    following: outgoing(follows),     // User[]
    followers: incoming(follows),     // User[]
    posts:     outgoing(authored),    // Post[]    (1:N)
    manager:   outgoing(reportsTo),   // User | null (N:1, follow the one-side)
    reports:   incoming(reportsTo),   // User[]    (N:1, many point at me)
  },

  access: { '*': Access.authenticated },

  handlers: {
    follow(state, targetId: string) {
      return emit({
        state,
        effects: [link(follows, '$key', targetId)],
      });
    },
    unfollow(state, targetId: string) {
      return emit({
        state,
        effects: [unlink(follows, '$key', targetId)],
      });
    },
  },
});
```

### 5.2 `outgoing()` / `incoming()` descriptors

Dual-purpose — same call used in both `edges:` and `source:` blocks:

```ts
// In edges block — returns a neighbor projection
edges: { following: outgoing(follows) }

// In source block — wraps for sourceCount
source: { followingCount: sourceCount(outgoing(follows)) }

// In component-side view composition — returns a ViewBuilder
const friends = useView(follows.outgoing(userId));  // method on edge, not wrapper
```

The `outgoing(edge)` free function returns an `EdgeDescriptor` (sentinel object). The same symbol is consumed by:
- `defineEntity({ edges: ... })` → auto-builds the view and populates `edges.following` in `useEntity` return
- `sourceCount(descriptor)` → compiles to a `SourceProjectionDef` matching the edge's backing table + direction column

### 5.3 Return shape of `useEntity`

**Breaking change (acceptable pre-1.0):** `useEntity` return gains an `edges` property.

```ts
interface UseEntityReturn<E extends AnyEntity> {
  readonly state: EntityRecord<E>;
  readonly edges: EntityEdges<E>;            // NEW
  readonly call: EntityCalls<E>;
  // ...status, pending, errors, etc. unchanged
}

type EntityEdges<E extends AnyEntity> = {
  readonly [K in keyof E['$edges']]: EdgeResult<
    E['$edges'][K]['$edge'],
    E['$edges'][K]['$direction']
  >;
};
```

If the entity declares no `edges:` block, `edges` is `{}`. Existing `useEntity` callers without `edges:` are unaffected at the call site — the breaking change is only that destructuring `{ state, call }` no longer exhaustively consumes the return (TypeScript reports no error; runtime adds an unused `edges: {}` field).

### 5.4 Each edge entry is lazy-backed

`edges.followers` returning `readonly User[]` is a **DBSP-view-backed array**, not eager memory. It has `.length`, `.slice()`, iterator protocol, and `.map()` — but the materialized set is only the rows the view engine streams to the client. For a user with millions of followers, the component must slice or paginate; the framework does not eagerly materialize the whole array.

Devtools warns when a component reads `.length` on an edge array with > 10,000 rows without slicing.

---

## 6. Query Methods on Edges

All methods return `ViewBuilder<T>` — composable with the existing view DSL (`.filter`, `.project`, `.topN`, `.aggregate`, `.join`).

### 6.1 On every edge

```ts
// One-hop
follows.outgoing(userId)         // users userId follows
follows.incoming(userId)         // users who follow userId
follows.connected(userId)        // union of both

// Recursive (uses fixpoint — see §7)
follows.reachable(userId)                  // transitive closure outgoing
follows.reachable(userId, { maxDepth: 3 }) // bounded
follows.reachableFrom(userId)              // transitive closure incoming
follows.pathTo(alice, bob)                 // shortest path with node list

// Composition via neighbor sets
follows.commonNeighbors(alice, bob)        // mutual friends
```

### 6.2 On `hierarchy()` only

```ts
commentTree.children(id)      // direct children (one-hop outgoing)
commentTree.parent(id)        // direct parent (one-hop incoming, singular)
commentTree.siblings(id)      // nodes sharing a parent with id (excluding id)
commentTree.ancestors(id)     // transitive incoming, ordered root→direct parent
commentTree.descendants(id)   // transitive outgoing, ordered by depth
commentTree.root(id)          // terminal ancestor (singular)
commentTree.depth(id)         // integer — count of ancestors
```

### 6.3 Composition examples

```tsx
// "Posts by users I follow, most recent 20"
const feed = useView(
  follows.outgoing(me)
    .join(authored.$table, users.id, authored.$table.from)
    .join(posts, authored.$table.to, posts.id)
    .topN(posts.createdAt, 20, 'desc'),
);

// "People I follow who also follow me" (reciprocals)
const reciprocals = useView(
  follows.commonNeighbors(me, me),   // me in both positions — degenerate but fine
);

// Or more explicitly:
const reciprocals2 = useView(
  follows.outgoing(me).intersect(follows.incoming(me)),
);
```

---

## 7. Recursive / Fixpoint Queries

### 7.1 Engine extension

The `dbsp-engine` gains a `recursive` operator. Wire format:

```ts
type Operator =
  | { op: 'filter'; ... }
  | { op: 'project'; ... }
  | { op: 'topN'; ... }
  | { op: 'aggregate'; ... }
  | { op: 'distinct'; ... }
  | { op: 'join'; ... }
  | {                                        // NEW
      op: 'recursive';
      base: Operator[];                      // pipeline producing the seed relation
      step: Operator[];                      // pipeline producing one iteration delta
      max_depth: number;                     // fixpoint safety bound; default 64
    };
```

**Semantics:** the engine evaluates `base` to produce R₀, then iteratively computes Rᵢ₊₁ = Rᵢ ∪ step(Rᵢ), stopping when either no new rows are produced (natural fixpoint) or `max_depth` is reached.

**Implementation shape (Rust, `packages/dbsp-engine/src/lib.rs`):**
- New variant in the operator enum
- Each iteration runs the `step` pipeline over the current accumulator
- Convergence check: count deltas produced in the iteration — zero = done
- Safety: hard cap at 1024 iterations, logs a warning at 512

**Incrementality:** when a new edge is inserted, the recursive view re-evaluates from the affected subgraph forward. For tree-structured inputs (hierarchies), this is O(depth). For dense graphs (social), worst-case touches the whole reachable set but still runs incrementally per delta.

### 7.2 View-builder method

The view DSL exposes `recursive()` as a new builder method:

```ts
view(edges.$table).recursive({
  base: (v) => v.filter('from', 'eq', startId),
  step: (v) => v.join(edges.$table, 'to', 'from'),
  maxDepth: 10,
});
```

Most users never touch this directly — edge methods (`edge.reachable`, `hierarchy.descendants`) wrap it. It's documented but marked as advanced.

### 7.3 Path queries

Shortest-path requires depth tracking inside the recursion. The engine's `recursive` operator is augmented with a per-iteration depth counter that the step pipeline can reference as a pseudo-column (`$depth`). For `pathTo`:

- Base: rows `{from: startId, to: startId, path: [startId], depth: 0}`
- Step: join to edges, append to path, increment depth, filter where `depth < maxDepth`
- Final filter: `to = targetId`, then `topN(depth, 1, 'asc')` to select the shortest

Path arrays are bounded — `maxDepth` defaults to 64, which is more than sufficient for typical social graph diameters and comment thread depths. Unbounded paths are explicitly opt-in via `{ maxDepth: Infinity }` and log a runtime warning.

### 7.4 Safety

- **Hard cap** at 1024 iterations regardless of `maxDepth`
- **Runtime warning** in devtools when a recursive view exceeds 100 iterations
- **Cycle handling** — deduplication on `(from, to)` per iteration prevents infinite loops on cyclic graphs
- **Memory cap** — result set size limited to 1M rows with a warning at 100k

---

## 8. Emit Integration — `link()` / `unlink()` Effects

Two new effects join `insert()`, `trigger()`, `publish()` in the emit-effect family.

### 8.1 Signatures

```ts
function link<E extends AnyEdge>(
  edge: E,
  from: string,
  to: string,
  props?: Partial<InferRecord<E['$props']>>,
): { $effect: 'link'; edge: E; from: string; to: string; props?: object };

function unlink<E extends AnyEdge>(
  edge: E,
  from: string,
  to: string,
): { $effect: 'unlink'; edge: E; from: string; to: string };
```

### 8.2 Use in `emit()`

```ts
handlers: {
  follow(state, targetId: string) {
    return emit({
      state,
      effects: [link(follows, '$key', targetId)],
    });
  },

  tagProduct(state, tagId: string, weight: number) {
    const now = Date.now();
    return emit({
      state,
      effects: [link(tagged, '$key', tagId, { weight, addedAt: now })],
    });
  },

  transferOwnership(state, toUserId: string, postId: string) {
    return emit({
      state,
      effects: [
        unlink(authored, '$key', postId),
        link(authored, toUserId, postId),
        insert(auditLog, { action: 'transfer_ownership', postId, toUserId }),
      ],
    });
  },
}
```

### 8.3 `$key` placeholder

Resolves to the entity instance's key at effect-publish time, identical to the existing `insert()` behavior.

### 8.4 Validation

At `link()` time:
- `(from, to)` uniqueness is checked unless `allowDuplicates: true`
- Cardinality constraints (unique-on-from / unique-on-to per §1.4) are checked
- Edge props are validated via the same column-validation path as `insert()`

Violations throw an `EdgeError` with codes `EDGE_DUPLICATE`, `EDGE_CARDINALITY_VIOLATION`, or `EDGE_PROP_INVALID`. These are framework errors (`SyncEngineError` subclass) — distinct from `EntityError` (domain-level).

---

## 9. Client Integration — `useEdge()` Hook

For component-side optimistic mutations (not from an actor handler).

```tsx
import { useEntity, useEdge } from '@syncengine/client';

function FollowButton({ me, them }: { me: string; them: string }) {
  const { link, unlink, pending } = useEdge(follows);

  return (
    <button
      disabled={pending}
      onClick={() => link(me, them)}
    >
      Follow
    </button>
  );
}
```

**Signature:**

```ts
function useEdge<E extends AnyEdge>(edge: E): {
  readonly link: (from: string, to: string, props?: Partial<InferRecord<E['$props']>>) => Promise<void>;
  readonly unlink: (from: string, to: string) => Promise<void>;
  readonly pending: boolean;
  readonly error: Error | null;
};
```

**Optimistic semantics:** `link()` applies locally immediately (edge appears in `edges.followers` on any component subscribing to the affected user entities), then reconciles with the server. If the server rejects (cardinality violation from concurrent write), the optimistic edge is removed and `error` is set.

---

## 10. Integration with `sourceCount`

Overload the existing `sourceCount` to accept an edge descriptor as a single arg:

```ts
// Existing — unchanged
sourceCount(transactions, transactions.productSlug)

// New overload
sourceCount(incoming(follows))    // count of edges with to = $key
sourceCount(outgoing(follows))    // count of edges with from = $key
```

**Implementation:** `outgoing(edge)` and `incoming(edge)` return an `EdgeDescriptor` tagged object. `sourceCount` branches on the input shape — if it's a table ref, behaves as today; if an edge descriptor, compiles to a `SourceProjectionDef` targeting `edge.$table` with `keyColumn: 'from' | 'to'` per the direction.

Analogous overloads for `sourceSum`, `sourceMin`, `sourceMax` accept `(outgoing(edge), edge.$props.weight)` — useful for summed-weight computations on tagged edges.

---

## 11. Channels and Access Control

Edges register in channels identically to tables. Either pass the edge's backing table or the edge reference itself — both accepted:

```ts
export const socialChannel = channel('social',
  [users, posts, follows, authored, reportsTo, commentTree],
  { access: Access.authenticated },
);
```

Internally the channel-registration code dereferences `edge.$table` when the argument is tagged `'edge'` / `'hierarchy'`.

Access policies on the underlying tables apply to the edges — edges inherit the channel's access rules for subscribe/publish.

---

## 12. File Locations

```
packages/core/src/
  edge.ts              (NEW)   — edge(), hierarchy(), Cardinality, descriptors
  schema.ts            (MODIFY) — add 'recursive' to Operator; recursive() on ViewBuilder
  entity.ts            (MODIFY) — edges: block; sourceCount overload; EdgeDescriptor
  channels.ts          (MODIFY) — accept edge refs in channel table list
  index.ts             (MODIFY) — export edge(), hierarchy(), link(), unlink(), outgoing(), incoming(), Cardinality

packages/dbsp-engine/src/
  lib.rs               (MODIFY) — add Recursive operator variant and fixpoint evaluator

packages/server/src/
  entity-runtime.ts    (MODIFY) — resolve $key in link/unlink; enforce cardinality + uniqueness

packages/client/src/
  entity-client.ts     (MODIFY) — useEntity returns { state, edges, call }; edge views registered
  store.ts             (MODIFY) — useEdge hook; optimistic link/unlink through rebase

packages/core/src/__tests__/
  edge.test.ts                 (NEW)   — edge() shape, cardinality, uniqueness
  edge-entity.test.ts          (NEW)   — edges: block, useEntity type inference
  edge-traversal.test.ts       (NEW)   — one-hop, recursive, hierarchy methods
  edge-emit.test.ts            (NEW)   — link/unlink effects, $key resolution, rebase
  edge-source-count.test.ts    (NEW)   — sourceCount overload

packages/dbsp-engine/src/
  lib.rs __tests__             (MODIFY) — recursive operator Rust tests

apps/test/src/
  entities/user.actor.ts       (NEW, demo) — follows + authored + reports
  entities/comment.actor.ts    (NEW, demo) — uses commentTree hierarchy
  schema.ts                    (MODIFY, demo) — add edges alongside existing tables
```

---

## 13. Implementation Surface

### 13.1 `packages/core/src/edge.ts` (NEW)

- `Cardinality` const object + type
- `edge()` function: synthesizes backing `Table`; returns `EdgeDef` with methods
- `hierarchy()` function: calls `edge()` with self-edge + ManyToOne + adds tree methods
- `outgoing()` / `incoming()` descriptors (dual-use in `edges:` and `source:` blocks)
- `link()` / `unlink()` effect constructors (return `{ $effect, edge, from, to, props? }`)
- Method builders: `outgoing`, `incoming`, `connected`, `reachable`, `reachableFrom`, `pathTo`, `commonNeighbors` — each composes a `ViewBuilder` via the new `recursive` operator where needed
- Hierarchy methods: `children`, `parent`, `siblings`, `ancestors`, `descendants`, `root`, `depth`
- Type helpers: `EdgeResult`, `EdgeColumns`, `InferEdgeRecord`, `AnyEdge`, `AnyHierarchy`
- Runtime guards: table name collision, cardinality validity, prop names

### 13.2 `packages/core/src/schema.ts` (MODIFY)

- Extend `Operator` union with `{ op: 'recursive', base, step, max_depth }`
- Add `.recursive()` method to `ViewBuilder<T>` — takes `{ base, step, maxDepth }`, returns a new view
- Update `classifyPipeline` — recursive is `non_monotonic`
- Update `extractMergeConfig` / any pipeline walkers to descend into base/step pipelines

### 13.3 `packages/core/src/entity.ts` (MODIFY)

- Add `edges?: EntityEdgesShape` to `EntityDef` generic and `entity()` config
- Validate edges-block at entity construction (no name collisions with state/source fields)
- Add `$edges` to `EntityDef` metadata
- Overload `sourceCount` to accept `EdgeDescriptor` in addition to `(table, column)`
- Add `SourceProjectionDef` variant for edge-backed projections (direction: `'from' | 'to'`)

### 13.4 `packages/dbsp-engine/src/lib.rs` (MODIFY)

- Add `Operator::Recursive { base, step, max_depth }` variant
- Implement fixpoint iteration:
  - Evaluate `base` pipeline → seed accumulator
  - Loop: apply `step` pipeline over accumulator; union deltas into accumulator
  - Convergence: no new rows OR iteration count ≥ `max_depth`
  - Safety: hard cap at 1024; warn at 512
- Support per-iteration `$depth` pseudo-column for path queries
- Incremental re-evaluation on upstream delta — affected nodes only
- Tests: cycle handling, convergence, bounded depth, shortest-path

### 13.5 `packages/server/src/entity-runtime.ts` (MODIFY)

- Handle `$effect: 'link' | 'unlink'` in emit-effect extraction
- Resolve `$key` / `$user` placeholders on from / to / props
- Enforce `(from, to)` uniqueness — pre-insert check against existing edge rows
- Enforce cardinality:
  - OneToOne: both `from` and `to` must be unique
  - OneToMany: `to` must be unique
  - ManyToOne: `from` must be unique
- Translate violations to `EdgeError` (`SyncEngineError` subclass) with `EdgeCode.DUPLICATE`, `EdgeCode.CARDINALITY_VIOLATION`, `EdgeCode.PROP_INVALID`

### 13.6 `packages/client/src/entity-client.ts` (MODIFY)

- `useEntity` return gains `edges: EntityEdges<E>`
- For each `edges:` entry, register a view at hook mount; deregister at unmount
- Edges field populated from view results, re-rendered on view delta
- Cardinality-aware type: singular-side wraps in `result[0] ?? null`; many-side wraps in `result`

### 13.7 `packages/client/src/store.ts` (MODIFY)

- `useEdge(edge)` hook: returns `{ link, unlink, pending, error }`
- Optimistic `link` / `unlink`: apply locally immediately via the existing pending-action queue, reconcile on server response
- Route through the same rebase mechanism as entity handlers — link/unlink are deterministic on the current state, so replay is idempotent

### 13.8 `packages/core/src/index.ts` (MODIFY)

- Export `edge`, `hierarchy`, `Cardinality`, `outgoing`, `incoming`, `link`, `unlink`, `useEdge` (from client re-export as appropriate)
- Export types: `EdgeDef`, `HierarchyDef`, `AnyEdge`, `AnyHierarchy`, `EdgeResult`, `EdgeDescriptor`, `TraversalOpts`, `PathRecord`

---

## 14. Demo Port — the Acid Test

Port one graph-shaped feature in `apps/test` as part of the spec's ship criteria:

**Comment thread** — a nested-comment widget that currently (if it existed) would require a `parentCommentId` column on `comments` table, a recursive view (impossible today), and manual depth-tracking.

After this spec:

```ts
// schema.ts
export const comments = table('comments', {
  id: id(),
  body: text(),
  authorId: text(),
  createdAt: integer(),
});
export const commentTree = hierarchy('commentTree', comments);
export const authoredComment = edge('authoredComment', users, comments,
  { cardinality: Cardinality.OneToMany });
```

```ts
// comment.actor.ts
export const comment = entity('comment', {
  state: { body: text() },
  edges: {
    parent:      incoming(commentTree),                  // Comment | null
    replies:     outgoing(commentTree),                  // Comment[]
    descendants: descendants(commentTree),               // Comment[] (recursive)
    author:      incoming(authoredComment),              // User | null
  },
  handlers: {
    reply(state, parentId: string, body: string, userId: string) {
      return emit({
        state: { ...state, body },
        effects: [
          link(commentTree, parentId, '$key'),
          link(authoredComment, userId, '$key'),
        ],
      });
    },
  },
});
```

```tsx
// ThreadView.tsx
function ThreadView({ rootId }: { rootId: string }) {
  const { state, edges } = useEntity(comment, rootId);
  return (
    <div>
      <CommentBody body={state.body} author={edges.author?.name} />
      <ul>
        {edges.replies.map((r) => <ThreadView key={r.id} rootId={r.id} />)}
      </ul>
    </div>
  );
}
```

**Acid test:** this file's line count ≤ its relational-equivalent written today. If yes, the abstraction earns its keep. If no, the spec is re-evaluated before merge.

---

## 15. Testing Strategy

**Framework:** vitest (matches existing `packages/core/src/__tests__/` — `.test.ts` suffix, colocated).

**Test levels:**

| Level | Scope | Location |
|-------|-------|----------|
| Type | Compile-time only — `edges` field type, cardinality inference | `edge-types.test-d.ts` (vitest `assertType`) |
| Unit — core | `edge()` shape, `hierarchy()` shape, method composition | `edge.test.ts` |
| Unit — entity integration | `edges:` block, `useEntity` type/runtime, `sourceCount` overload | `edge-entity.test.ts`, `edge-source-count.test.ts` |
| Unit — emit | `link()` / `unlink()` effects, `$key` resolution, uniqueness, cardinality violations | `edge-emit.test.ts` |
| Unit — recursive | One-hop, bounded-depth, cycle handling, hierarchy tree methods | `edge-traversal.test.ts` |
| Engine | `Recursive` operator fixpoint convergence, shortest-path, cycle dedup, max_depth cap | `packages/dbsp-engine/src/lib.rs` Rust tests |
| Integration | Full round-trip: client `useEdge.link()` → server `entity-runtime` → edge table write → NATS broadcast → view update on peer client | `edge-e2e.test.ts` in `apps/test/src/__tests__/` |

**Coverage expectations:**
- Core edge + hierarchy + descriptor helpers: 100% line coverage
- Emit effect handling: 100% line coverage including error paths
- Engine recursive operator: 90%+ with dedicated cycle / convergence / bounded-depth tests
- Client useEdge: optimistic paths + rollback on server reject

**Specific test cases to ship:**
1. `follows.reachable(a)` on a cycle `a → b → a` terminates correctly
2. `hierarchy.descendants()` on a 10-deep comment tree returns all leaves
3. Two concurrent `link(reportsTo, x, y)` calls with `ManyToOne` — one succeeds, one throws
4. `useEntity(user, id).edges.manager` narrows to `User | null` (type-test)
5. `sourceCount(incoming(follows))` tracks the count incrementally across 1000 link/unlink ops
6. Optimistic `link()` applies locally in <16ms; rolls back cleanly on server reject

---

## 16. Commands

```
Build:        pnpm build                          (bundles apps/test + packages)
Build WASM:   pnpm build:wasm                     (required after dbsp-engine changes — see WASM sync gotcha in MEMORY.md)
Dev:          pnpm dev                            (runs apps/test with live reload)
Test:         pnpm test                           (vitest in apps/test; filters packages)
Typecheck:    pnpm typecheck                      (recursive across workspaces)
Lint:         pnpm lint                           (eslint via apps/test)
```

After any `packages/dbsp-engine/` change: `pnpm build:wasm` before `pnpm test` — per the WASM sync gotcha, rebuilds don't refresh the stale pnpm file: copy automatically. Verify via md5 of `pkg/` vs `node_modules/.pnpm/.../dbsp_bg.wasm`.

---

## 17. Boundaries

**Always:**
- Use typed `edge()` / `hierarchy()` references; never raw string table names in edge methods
- Register edges (or their `$table`) in at least one channel for sync/access
- Preserve cardinality-aware return types — singular sides are `T | null`, never `T[0]`
- Enforce `(from, to)` uniqueness unless `allowDuplicates: true` is explicit
- Cap recursive queries with `maxDepth` — default 64, hard cap 1024

**Ask first:**
- Adding new `Operator` variants beyond `recursive`
- Changing `dbsp-engine/src/lib.rs` public types or wire format (backward compat)
- Extending `useEntity` return shape with additional top-level fields beyond `edges`
- Adding cardinality-specific optimizations to the engine (different storage for 1:1 vs M:N)
- Introducing cascade-delete semantics (explicit non-goal for v1)

**Never:**
- Allow magic strings where a typed ref exists (edge names, column names, direction keywords)
- Silently overwrite on cardinality violations — always throw
- Materialize unbounded recursion (`maxDepth: Infinity`) without a runtime warning
- Pre-materialize all edge views eagerly — they must be lazy-backed by DBSP views
- Skip value-object validation on edge props (`link(tagged, a, b, { weight: -1 })` with a validated `Money`-like prop must throw)

---

## 18. Success Criteria

1. **Port test passes (§14).** The comment-thread component in `apps/test` is ≤ its relational-equivalent line count and renders live.
2. **Type inference.** `const { edges } = useEntity(user, id); edges.manager.name` compiles iff cardinality is `OneToOne` or `ManyToOne` — else must be narrowed through `edges.manager?.name`.
3. **Fixpoint correctness.** Engine tests pass: reachability on cycles, 10-deep hierarchies, shortest-path on 1000-node graphs, bounded depth truncation.
4. **Incremental recompute.** Inserting one edge triggers only affected subgraph recomputation in the `recursive` operator — verified by per-op row-touched counts in engine tests.
5. **Optimistic mutation.** `useEdge.link()` updates local state within one render frame; rolls back cleanly on server reject.
6. **Cardinality enforcement.** Attempting a second outgoing edge under `OneToOne` or `ManyToOne` throws `EdgeError.CARDINALITY_VIOLATION` server-side and reverts client-side.
7. **Channels.** Edges participate in existing `channel()` registration unchanged — demonstrated by a test that subscribes to `socialChannel` and observes edge deltas.
8. **No magic strings.** Codebase-wide grep confirms no string-literal edge names or direction keywords in user code — all typed references.
9. **WASM build integration.** `pnpm build:wasm && pnpm test` runs clean after the `Recursive` operator lands.
10. **Documentation.** `hierarchy('commentTree', comments)` appears as the first example on the `/docs/entities` page.

---

## 19. Non-Goals (v1)

- **Cypher-style parsed DSL.** Method chaining is the only query composition.
- **FK-implies-edge auto-inference.** Edges stay explicit.
- **Ordered edges / fractional indexing.** Orthogonal concern — can be added later without API breakage.
- **Entity-as-node.** Edges connect tables only; entities reference via their backing rows.
- **Cascade delete.** When a row in `users` is deleted, its `follows` edges become orphaned; cleanup is the application's responsibility. Add `onDelete: 'cascade'` in a follow-up spec.
- **Weighted shortest path with arbitrary cost functions.** Only unweighted / edge-count-shortest supported in v1.
- **Convenience constructors `manyToMany`, `hasMany`.** Redundant with `edge(..., { cardinality })`. Only `hierarchy()` survives because tree-specific methods earn the sugar.
- **Devtools live graph view.** Separate follow-up spec — the API / storage / queries ship first, the visual ships after.
- **Edge-as-entity.** Edges are data, not actors. If you need handlers on a relationship, model it as an entity with FK state fields, not an edge.

---

## 20. Open Questions

1. **Edge prop value-object validation path.** Does `link(tagged, a, b, { weight: Money.usd(100) })` run the `Money` invariant? Assumed yes (reuse `validateInsertValueColumns` from `entity.ts`) but needs confirmation that the effect-validation plumbing threads through identically.

2. **`reachable()` result ordering.** Should results stream in BFS order, DFS order, or insertion-order of discovery? Proposal: BFS (closest-first), with `{ order: 'bfs' | 'dfs' }` opt-in. Resolve during engine implementation.

3. **Hook-level subscription lifecycle.** Each `edges:` entry registers a view — when the component unmounts, do we synchronously tear down the view subscription, or reference-count across siblings? Existing `useView` practice should determine this; flag if unclear during implementation.

4. **`commonNeighbors` with asymmetric edges.** Well-defined for `M:N` (`follows`) where both positions make sense. Degrades to less-useful cases on `1:N` — should the method be typed away from those? Proposal: only expose `commonNeighbors` on `ManyToMany` and self-edges. Confirm during type-level design.

5. **`recursive` operator and join right-side.** The step pipeline joins back to the source edge table. Does the existing `join` operator support joining a view to a table, or only two tables? May need a minor generalization. Flag in engine design.

---

## 21. Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-22 | Fixpoint operator in engine (Option C) | User chose complete ship over incremental. Unlocks real graph queries, avoids shipping a half-measure that needs re-architecture. |
| 2026-04-22 | Synthetic `id()` PK for edges, `(from, to)` uniqueness by default | Supports prop-carrying edges without composite-key complexity; uniqueness enforced at `link()` time. |
| 2026-04-22 | Runtime cardinality enforcement (throw) | Types and runtime must agree — silent overwrite is a footgun, type-only drifts. |
| 2026-04-22 | `useEntity` return shape extended (breaking) | Project is pre-1.0; `{ state, edges, call }` is the right shape long-term, and a separate hook breaks the "object with relationships" mental model. |
| 2026-04-22 | Devtools graph view deferred to follow-up spec | API / storage / queries are the prerequisites; visual can ship independently. |
| 2026-04-22 | `hierarchy()` kept; `manyToMany` / `hasMany` dropped | Only hierarchy earns sugar via tree-specific methods (`ancestors`, `descendants`, `depth`, `root`). The others are `edge(..., { cardinality })` with no additional methods. |

---

## 22. Implementation Order

Suggested sequencing — each stage produces a shippable artifact; later stages depend on earlier ones.

1. **Engine foundation** — `Recursive` operator in `dbsp-engine/src/lib.rs` + Rust tests + WASM build verified. No user-facing changes yet.
2. **View DSL recursive method** — `view().recursive({ base, step, maxDepth })` in `schema.ts` + tests. Still no graph API.
3. **Core `edge()` + `hierarchy()` primitives** — `edge.ts` with declaration, backing table, no-hop methods (`outgoing`, `incoming`). Unit tests.
4. **Recursive edge methods** — `reachable`, `pathTo`, hierarchy tree methods. Wired through the engine. Unit + engine tests.
5. **Emit integration** — `link()` / `unlink()` effects + server-side enforcement (uniqueness, cardinality). Integration tests.
6. **Entity `edges:` block** — `defineEntity` extension + `useEntity` return shape change + type inference. Type tests + runtime tests.
7. **`sourceCount` overload** — accept edge descriptors. Unit tests.
8. **Client `useEdge()` hook** — optimistic link/unlink + rollback. Integration tests.
9. **Demo port (acid test)** — comment thread in `apps/test`. Verify line-count reduction.
10. **Docs** — update `/docs/entities` with edges-block example; add `/docs/edges` page covering the full API.

Stages 1–4 are the heavy lifting (engine + query surface). Stages 5–8 are integration (bolt onto existing entity/client infrastructure). Stage 9 is verification. Stage 10 is documentation.
