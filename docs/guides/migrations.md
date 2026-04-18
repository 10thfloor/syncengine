# Migrations Guide

> Client-side SQLite replicas need schema evolution. Users on older
> tabs, old service workers, and fresh clients all need to converge on
> the same shape as the server expects. Migrations are how syncengine
> lands column adds, renames, drops, and new tables safely across the
> fleet.

## What migrations do — and don't

**Scope:** client-side SQLite replicas only. Every browser tab keeps a
local replica of the tables it subscribes to (`@sqlite.org/sqlite-wasm`
in a Worker). When you change a table's column set, each connected
client needs its local schema to match, or CRDT deltas streaming in
from NATS won't map onto the local table cleanly.

Migrations do **not** apply to:

- **Entity state** — Restate virtual objects carry their own
  JSON-shaped state. Field adds are backward-compatible by default
  (old state missing a field reads as `undefined`); field removes and
  renames need a hand-rolled handler, not a migration step.
- **NATS JetStream deltas** — the event log is append-only and schema-
  free on the wire. If you rename a column, old deltas in the stream
  still reference the old name; the client materialization applies
  your rename in its local replica before consuming deltas.
- **Bus payloads** — bus schemas are versioned by declaration, not by
  migration. Changing a Zod schema is a breaking change for every
  subscriber; plan it like any API change.

## Declaring migrations

Two pieces on your store config:

```ts
// src/db.ts
import { store } from '@syncengine/client';
import { notes, thumbs } from './schema';

export const db = store({
  tables: [notes, thumbs] as const,
  views: { /* ... */ },

  schemaVersion: 3,
  migrations: [
    {
      version: 2,
      steps: [
        { op: 'addColumn', table: 'notes', column: 'tags',
          type: 'TEXT', default: '' },
      ],
    },
    {
      version: 3,
      steps: [
        { op: 'addColumn', table: 'notes', column: 'archivedAt',
          type: 'INTEGER', nullable: true },
      ],
    },
  ],
});
```

- `schemaVersion` is the target version. Bump it every time you change
  the schema shape, even if the change is additive.
- `migrations` is an array of `{ version, steps }`. `version` is the
  **target version after applying this migration**, not the "from"
  version — so the example above migrates v1 → v2 and v2 → v3.
- Unversioned clients start at `schema_version = 0` and apply every
  migration in order.

## The four ops

| Op            | Use for                          | SQL emitted                                             |
|---------------|----------------------------------|---------------------------------------------------------|
| `addColumn`   | new field on an existing table   | `ALTER TABLE t ADD COLUMN c TYPE [NOT NULL DEFAULT ...]` |
| `renameColumn`| field rename                     | `ALTER TABLE t RENAME COLUMN from TO to`                |
| `dropColumn`  | remove a field                   | `ALTER TABLE t DROP COLUMN c`                           |
| `addTable`    | new table already in your schema | `CREATE TABLE IF NOT EXISTS ...`                        |

### `addColumn`

```ts
{ op: 'addColumn', table: 'notes', column: 'tags',
  type: 'TEXT', default: '' }
```

Fields:
- `table` / `column` — target
- `type` — SQLite type: `TEXT`, `INTEGER`, `REAL`, `BLOB`
- `default` (optional) — literal default for existing rows
- `nullable` (optional, default `false`) — allow `NULL`

**Cross-device safety:** if `nullable: false` and no `default`, the
step is flagged by `validateMigrationStep` as **unsafe** — older
clients that haven't yet applied the migration will fail to `INSERT`.
Always provide a default for non-nullable adds, or make the column
nullable.

### `renameColumn`

```ts
{ op: 'renameColumn', table: 'notes', from: 'body', to: 'content' }
```

Fast in SQLite 3.25+. Local only — the wire-format CRDT delta still
carries the server's column name; the materialization layer maps
server → local column names based on the current schema version.

### `dropColumn`

```ts
{ op: 'dropColumn', table: 'notes', column: 'legacy' }
```

Supported in SQLite 3.35+ (all recent browsers). Drops historical
data in the replica; remote stream still has it, but nothing in your
client code references it anymore.

### `addTable`

```ts
{
  op: 'addTable',
  table: 'reactions',
  columns: {
    id:     { sqlType: 'INTEGER PRIMARY KEY', nullable: false },
    noteId: { sqlType: 'INTEGER',             nullable: false },
    emoji:  { sqlType: 'TEXT',                nullable: false },
  },
}
```

Use this when you added a new `table(...)` declaration to your
schema. The `sqlType` strings are raw SQLite column definitions —
`addTable` is the one op that doesn't map 1:1 to a framework column
helper, because the table didn't exist before the migration.

> **Heads-up:** `addTable` in a migration needs to be paired with the
> matching `table('reactions', { ... })` declaration in `schema.ts` so
> the runtime knows the table exists for subscriptions, views, and
> channels. Think of the migration as applying the schema to already-
> deployed clients; the `table()` declaration is what the rest of the
> framework reads.

## How it runs

The data-worker in the browser tab runs migrations at init time:

1. Reads `_dbsp_meta.schema_version` — the current version stored in
   SQLite. Defaults to `0` on a fresh replica.
2. Compares against `schemaVersion`. If already ≥ target, skip.
3. Applies each matching migration in order, running each step's SQL
   inside the SQLite worker thread.
4. On success, writes the new version into `_dbsp_meta` and emits a
   `MIGRATION_STATUS: complete` message to the main thread.
5. On failure, writes `version - 1` (last fully successful version),
   emits `MIGRATION_STATUS: failed`, and stops. Subsequent boots re-
   attempt from the partial point.

You'll see this in the browser console on an upgrade:

```
[migrations] migrating v1 → v3
[migrations] v2: ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT ''
[migrations] v3: ALTER TABLE notes ADD COLUMN archivedAt INTEGER
[migrations] complete: v1 → v3 (2 steps)
```

## Observing migration status

The store's `useSyncStatus` hook (or equivalent low-level subscription)
surfaces `MIGRATION_STATUS` events if you want to show a loading
banner during long migrations. Usually unnecessary — column adds are
near-instant — but consider it for `addTable` on large-history clients
or `dropColumn` that rewrites a big table.

## Validating before you ship

Every migration should pass `validateMigration` in your tests:

```ts
import { validateMigration } from '@syncengine/core';
import { migrations } from '../db';

it('every migration is cross-device safe', () => {
  for (const m of migrations) {
    const { safe, errors } = validateMigration(m);
    expect(safe, errors.join('\n')).toBe(true);
  }
});
```

The validator flags:
- `addColumn` with `nullable: false` and no `default` → older clients
  can't insert.

It does **not** flag `dropColumn` or `renameColumn`, because those
only affect clients that have applied the migration — older clients
still see the old shape in their local replica.

## Patterns

### Additive changes are free

Adding a column or table requires no coordination with deployed
clients. Bump `schemaVersion`, add a `migration`, ship. Older tabs
continue running with the old local shape; when they next
subscribe/boot, they run the migration and catch up.

### Renames are a two-step dance

If the server-side schema (`table('notes', {...})` declaration) and
the client-side column name need to diverge temporarily, use:

1. **Ship v2**: `addColumn` the new name, keep the old as a synonym.
   Entity handlers and views can start reading from either.
2. **Ship v3** later, after every client has reached v2:
   `renameColumn` the old away, `dropColumn` if needed.

Skipping the two-step leaves old-client-published deltas flowing into
a column name that doesn't exist in a mid-upgrade replica.

### Can I run arbitrary SQL?

Not from a migration step — the four ops are the contract. If you
need data rewrites (splitting a column, backfilling from another
source), do it in an entity handler that consumes the old shape and
emits into the new one, then drop the old column in a later
migration once every client has caught up.

## Footguns

- **Forgetting `schemaVersion` bumps.** The migration array can be
  populated but nothing runs until `schemaVersion` exceeds the stored
  version. Double-check the number changed.
- **Non-monotonic `version` numbers.** The data-worker sorts
  migrations by `version` ascending, but gaps are silently allowed
  (v1 → v3 with no v2 works). Don't do it — makes history
  hard to reason about.
- **Rollbacks.** Not currently supported. Once a column is dropped,
  you can't recover it from the local replica; data is still live in
  the NATS stream, but the framework doesn't re-materialize dropped
  columns on a re-migration. Plan drops carefully.
- **Migrations run per-tab.** Every connected tab applies its own
  migration. For N-tab fleets the same ALTER TABLE runs N times, each
  on a local SQLite — cheap, but worth knowing if you're logging.

## Links

- Source: [`packages/core/src/migrations.ts`](../../packages/core/src/migrations.ts)
- Runner (browser): [`packages/client/src/workers/data-worker.js`](../../packages/client/src/workers/data-worker.js) — `runMigrations()` + `handleSchemaMigrationNotification()`
- Tests: [`packages/core/src/__tests__/schema-migrations.test.ts`](../../packages/core/src/__tests__/schema-migrations.test.ts)
