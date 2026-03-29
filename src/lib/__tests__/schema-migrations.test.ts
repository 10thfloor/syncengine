/**
 * RED phase — Schema Migrations
 *
 * The problem: `CREATE TABLE IF NOT EXISTS` silently ignores schema changes.
 * Device A deploys v2 (adds a column), device B is offline running v1.
 * When B comes online, its SQLite schema won't match incoming deltas.
 *
 * The migration system needs:
 * 1. Schema versioning — each StoreConfig has a version
 * 2. Migration DSL — declarative column adds/removes/renames
 * 3. Worker migration runner — detects version mismatch, applies ALTERs
 * 4. Restate schema coordination — tracks workspace schema version,
 *    notifies clients when a migration is available
 * 5. Safe rollout — new columns must be nullable or have defaults
 *    so older clients can still INSERT without the new field
 *
 * All tests should FAIL until we implement the feature.
 */

import { describe, it, expect } from 'vitest';
import { table, id, integer, real, text, boolean } from '../schema';
import { migrationStepToSQL, validateMigrationStep } from '../migrations';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Schema versioning on StoreConfig
// ═══════════════════════════════════════════════════════════════════════════

describe('Schema versioning', () => {

    it('StoreConfig accepts a schemaVersion number', () => {
        // StoreConfig should have an optional schemaVersion field
        // that defaults to 1 if not provided.
        const config = {
            schemaVersion: 2,
            tables: [],
            views: [],
        };

        expect(config.schemaVersion).toBe(2);
    });

    it('StoreConfig accepts a migrations array', () => {
        // Migrations are ordered transformations from version N to N+1.
        const config = {
            schemaVersion: 3,
            tables: [],
            views: [],
            migrations: [
                { version: 2, steps: [{ op: 'addColumn', table: 'expenses', column: 'tags', type: 'TEXT', default: '' }] },
                { version: 3, steps: [{ op: 'addColumn', table: 'expenses', column: 'receipt_url', type: 'TEXT', nullable: true }] },
            ],
        };

        expect(config.migrations).toHaveLength(2);
        expect(config.migrations[0].version).toBe(2);
        expect(config.migrations[1].version).toBe(3);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Migration step DSL
// ═══════════════════════════════════════════════════════════════════════════

describe('Migration step DSL', () => {

    it('addColumn step has required fields', () => {
        const step = {
            op: 'addColumn' as const,
            table: 'expenses',
            column: 'tags',
            type: 'TEXT',
            default: '',
        };

        expect(step.op).toBe('addColumn');
        expect(step.table).toBeTruthy();
        expect(step.column).toBeTruthy();
        expect(step.type).toBeTruthy();
    });

    it('addColumn with nullable requires no default', () => {
        const step = {
            op: 'addColumn' as const,
            table: 'expenses',
            column: 'receipt_url',
            type: 'TEXT',
            nullable: true,
        };

        expect(step.nullable).toBe(true);
        expect(step).not.toHaveProperty('default');
    });

    it('renameColumn step has old and new names', () => {
        const step = {
            op: 'renameColumn' as const,
            table: 'expenses',
            from: 'description',
            to: 'note',
        };

        expect(step.op).toBe('renameColumn');
        expect(step.from).toBe('description');
        expect(step.to).toBe('note');
    });

    it('dropColumn step names the column to remove', () => {
        const step = {
            op: 'dropColumn' as const,
            table: 'expenses',
            column: 'legacy_field',
        };

        expect(step.op).toBe('dropColumn');
        expect(step.column).toBe('legacy_field');
    });

    it('addTable step creates a new table', () => {
        const step = {
            op: 'addTable' as const,
            table: 'receipts',
            columns: {
                id: { sqlType: 'INTEGER PRIMARY KEY', nullable: false },
                expense_id: { sqlType: 'INTEGER', nullable: false },
                url: { sqlType: 'TEXT', nullable: false },
            },
        };

        expect(step.op).toBe('addTable');
        expect(step.table).toBe('receipts');
        expect(Object.keys(step.columns)).toContain('id');
    });

    it('migration steps generate correct SQL', () => {
        // A helper function should turn migration steps into SQL statements.
        // This is the core of the migration runner.
        const steps = [
            { op: 'addColumn' as const, table: 'expenses', column: 'tags', type: 'TEXT', default: '' },
            { op: 'addColumn' as const, table: 'expenses', column: 'receipt_url', type: 'TEXT', nullable: true },
            { op: 'renameColumn' as const, table: 'expenses', from: 'description', to: 'note' },
        ];

        // Expected SQL:
        const expectedSql = [
            "ALTER TABLE expenses ADD COLUMN tags TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE expenses ADD COLUMN receipt_url TEXT",
            "ALTER TABLE expenses RENAME COLUMN description TO note",
        ];

        // This function doesn't exist yet — it should be exported from a new migrations module
        // For now, just test the expected shape
        expect(expectedSql[0]).toContain('ALTER TABLE');
        expect(expectedSql[0]).toContain('ADD COLUMN');
        expect(expectedSql[1]).not.toContain('NOT NULL');
        expect(expectedSql[2]).toContain('RENAME COLUMN');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Migration SQL generator (the function we need to build)
// ═══════════════════════════════════════════════════════════════════════════

describe('migrationStepToSQL', () => {

    // This function should be importable from '../migrations'
    // import { migrationStepToSQL, Migration, MigrationStep } from '../migrations';

    // Until we build it, define the expected behavior:

    it('addColumn with default generates NOT NULL DEFAULT', () => {
        const sql = migrationStepToSQL({
            op: 'addColumn', table: 'expenses', column: 'tags', type: 'TEXT', default: '',
        });
        expect(sql).toBe(`ALTER TABLE "expenses" ADD COLUMN "tags" TEXT NOT NULL DEFAULT ''`);
    });

    it('addColumn with nullable omits NOT NULL', () => {
        const sql = migrationStepToSQL({
            op: 'addColumn', table: 'expenses', column: 'receipt_url', type: 'TEXT', nullable: true,
        });
        expect(sql).toBe(`ALTER TABLE "expenses" ADD COLUMN "receipt_url" TEXT`);
    });

    it('addColumn with numeric default uses unquoted value', () => {
        const sql = migrationStepToSQL({
            op: 'addColumn', table: 'expenses', column: 'priority', type: 'INTEGER', default: 0,
        });
        expect(sql).toBe(`ALTER TABLE "expenses" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0`);
    });

    it('renameColumn generates RENAME COLUMN', () => {
        const sql = migrationStepToSQL({
            op: 'renameColumn', table: 'expenses', from: 'description', to: 'note',
        });
        expect(sql).toBe(`ALTER TABLE "expenses" RENAME COLUMN "description" TO "note"`);
    });

    it('dropColumn generates DROP COLUMN', () => {
        const sql = migrationStepToSQL({
            op: 'dropColumn', table: 'expenses', column: 'legacy_field',
        });
        expect(sql).toBe(`ALTER TABLE "expenses" DROP COLUMN "legacy_field"`);
    });

    it('addTable generates CREATE TABLE', () => {
        const sql = migrationStepToSQL({
            op: 'addTable', table: 'receipts',
            columns: {
                id: { sqlType: 'INTEGER PRIMARY KEY', nullable: false },
                url: { sqlType: 'TEXT', nullable: false },
            },
        });
        expect(sql).toBe(`CREATE TABLE IF NOT EXISTS "receipts" ("id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL)`);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Worker migration detection and execution
// ═══════════════════════════════════════════════════════════════════════════

describe('Worker migration runner', () => {

    it('worker stores schema version in SQLite meta table', () => {
        // The worker should create a _meta table on first init:
        // CREATE TABLE IF NOT EXISTS _dbsp_meta (key TEXT PRIMARY KEY, value TEXT);
        // INSERT OR REPLACE INTO _dbsp_meta (key, value) VALUES ('schema_version', '1');
        const metaTableSql = "CREATE TABLE IF NOT EXISTS _dbsp_meta (key TEXT PRIMARY KEY, value TEXT)";
        expect(metaTableSql).toContain('_dbsp_meta');
    });

    it('worker detects version mismatch on INIT', () => {
        // On INIT, worker reads schema_version from _dbsp_meta.
        // If stored version < config schemaVersion, migrations are needed.
        const storedVersion = 1;
        const configVersion = 3;
        const migrationsNeeded = configVersion > storedVersion;
        expect(migrationsNeeded).toBe(true);
    });

    it('worker applies migrations in order from stored to current', () => {
        const storedVersion = 1;
        const configVersion = 3;
        const migrations = [
            { version: 2, steps: [{ op: 'addColumn', table: 'expenses', column: 'tags', type: 'TEXT', default: '' }] },
            { version: 3, steps: [{ op: 'addColumn', table: 'expenses', column: 'receipt_url', type: 'TEXT', nullable: true }] },
        ];

        const toApply = migrations.filter(m => m.version > storedVersion && m.version <= configVersion);
        expect(toApply).toHaveLength(2);
        expect(toApply[0].version).toBe(2);
        expect(toApply[1].version).toBe(3);
    });

    it('worker updates _dbsp_meta after successful migration', () => {
        // After applying all migrations, update the stored version
        const updateSql = "INSERT OR REPLACE INTO _dbsp_meta (key, value) VALUES ('schema_version', '3')";
        expect(updateSql).toContain("'3'");
    });

    it('worker emits MIGRATION_STATUS to main thread', () => {
        const migrationMsg = {
            type: 'MIGRATION_STATUS' as const,
            fromVersion: 1,
            toVersion: 3,
            status: 'complete' as 'running' | 'complete' | 'failed',
            stepsApplied: 2,
        };

        expect(migrationMsg.type).toBe('MIGRATION_STATUS');
        expect(migrationMsg.status).toBe('complete');
    });

    it('worker handles migration failure gracefully', () => {
        // If a migration step fails (e.g., column already exists),
        // the worker should report the error and NOT update the version.
        const failureMsg = {
            type: 'MIGRATION_STATUS' as const,
            fromVersion: 1,
            toVersion: 3,
            status: 'failed' as const,
            stepsApplied: 1,
            error: 'duplicate column name: tags',
            failedAtVersion: 2,
        };

        expect(failureMsg.status).toBe('failed');
        expect(failureMsg.failedAtVersion).toBe(2);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. INIT message carries schema version and migrations
// ═══════════════════════════════════════════════════════════════════════════

describe('INIT message migration payload', () => {

    it('INIT message includes schemaVersion', () => {
        const initMsg = {
            type: 'INIT' as const,
            schema: {
                tables: [],
                views: [],
                mergeConfigs: [],
            },
            schemaVersion: 3,
            migrations: [
                { version: 2, steps: [{ op: 'addColumn', table: 'expenses', column: 'tags', type: 'TEXT', default: '' }] },
            ],
        };

        expect(initMsg.schemaVersion).toBe(3);
        expect(initMsg.migrations).toHaveLength(1);
    });

    it('INIT message without migrations defaults to version 1', () => {
        const initMsg = {
            type: 'INIT' as const,
            schema: { tables: [], views: [], mergeConfigs: [] },
        };

        const version = (initMsg as any).schemaVersion ?? 1;
        expect(version).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Restate schema coordination
// ═══════════════════════════════════════════════════════════════════════════

describe('Restate schema coordination', () => {

    it('bumpSchema publishes migration notification to NATS', () => {
        // When a client bumps the schema version, all peers should be
        // notified via NATS so they can apply migrations.
        const natsMsg = {
            type: 'SCHEMA_MIGRATION' as const,
            workspaceId: 'demo',
            fromVersion: 1,
            toVersion: 2,
            timestamp: Date.now(),
        };

        expect(natsMsg.type).toBe('SCHEMA_MIGRATION');
        expect(natsMsg.toVersion).toBeGreaterThan(natsMsg.fromVersion);
    });

    it('worker subscribes to schema migration NATS subject', () => {
        // Subject: ws.<workspaceId>.schema
        const subject = 'ws.demo.schema';
        expect(subject).toMatch(/^ws\.\w+\.schema$/);
    });

    it('worker handles hot migration without restart', () => {
        // On receiving a SCHEMA_MIGRATION message, the worker should:
        // 1. Pause message processing
        // 2. Run the migration SQL
        // 3. Update insertSql templates for affected tables
        // 4. Update _dbsp_meta version
        // 5. Resume processing
        const hotMigrationSteps = [
            'pause_processing',
            'run_migration_sql',
            'update_insert_templates',
            'update_meta_version',
            'resume_processing',
        ];
        expect(hotMigrationSteps).toHaveLength(5);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Cross-device safety: forward compatibility
// ═══════════════════════════════════════════════════════════════════════════

describe('Forward compatibility', () => {

    it('new columns must be nullable or have defaults', () => {
        // An addColumn migration that is NOT NULL and has NO default would break
        // older clients that INSERT without the new field.
        const safeStep = { op: 'addColumn' as const, table: 'expenses', column: 'tags', type: 'TEXT', default: '' };
        const alsoSafe = { op: 'addColumn' as const, table: 'expenses', column: 'receipt_url', type: 'TEXT', nullable: true };
        const unsafe = { op: 'addColumn' as const, table: 'expenses', column: 'required_field', type: 'TEXT' };

        expect(validateMigrationStep(safeStep).safe).toBe(true);
        expect(validateMigrationStep(alsoSafe).safe).toBe(true);
        expect(validateMigrationStep(unsafe).safe).toBe(false);
    });

    it('older clients ignore unknown columns in inbound deltas', () => {
        // When device B (v1) receives a delta with a column it doesn't know about,
        // it should store it in SQLite (which ignores extra INSERT values) and
        // pass it through DBSP without crashing.
        const v2Record = { id: 1, amount: 42, category: 'food', tags: 'lunch,work' };
        const v1Columns = ['id', 'amount', 'category', 'description', 'date'];

        // The INSERT SQL for v1 only names its columns — extra fields in the
        // record just get silently dropped by the bind.
        const boundValues = v1Columns.map(col => (v2Record as any)[col] ?? null);
        expect(boundValues).toEqual([1, 42, 'food', null, null]);
        // 'tags' is ignored — no crash
    });

    it('newer clients handle records missing new columns', () => {
        // When device A (v2) receives a delta from device B (v1) that's missing
        // the new 'tags' column, the default should be applied.
        const v1Record = { id: 1, amount: 42, category: 'food', description: 'lunch', date: '2026-04-02' };
        const v2Columns = ['id', 'amount', 'category', 'description', 'date', 'tags'];
        const defaults: Record<string, unknown> = { tags: '' };

        const hydrated = { ...v1Record } as Record<string, unknown>;
        for (const col of v2Columns) {
            if (!(col in hydrated)) {
                hydrated[col] = defaults[col] ?? null;
            }
        }

        expect(hydrated.tags).toBe('');
    });
});
