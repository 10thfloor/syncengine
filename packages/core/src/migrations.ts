// ── Migration types ─────────────────────────────────────────────────────────

import { escapeIdentifier, escapeLiteral } from './sql-gen';

export type MigrationStep =
    | { op: 'addColumn'; table: string; column: string; type: string; default?: string | number | boolean; nullable?: boolean }
    | { op: 'renameColumn'; table: string; from: string; to: string }
    | { op: 'dropColumn'; table: string; column: string }
    | { op: 'addTable'; table: string; columns: Record<string, { sqlType: string; nullable?: boolean }> };

export interface Migration {
    /** Target version after applying this migration */
    version: number;
    steps: MigrationStep[];
}

// ── SQL generation ──────────────────────────────────────────────────────────

export function migrationStepToSQL(step: MigrationStep): string {
    switch (step.op) {
        case 'addColumn': {
            const tbl = escapeIdentifier(step.table);
            const col = escapeIdentifier(step.column);
            const parts = [`ALTER TABLE ${tbl} ADD COLUMN ${col} ${step.type}`];
            if (!step.nullable) {
                parts.push('NOT NULL');
                if (step.default !== undefined) {
                    parts.push(`DEFAULT ${escapeLiteral(step.default)}`);
                }
            }
            return parts.join(' ');
        }
        case 'renameColumn':
            return `ALTER TABLE ${escapeIdentifier(step.table)} RENAME COLUMN ${escapeIdentifier(step.from)} TO ${escapeIdentifier(step.to)}`;
        case 'dropColumn':
            return `ALTER TABLE ${escapeIdentifier(step.table)} DROP COLUMN ${escapeIdentifier(step.column)}`;
        case 'addTable': {
            const cols = Object.entries(step.columns)
                .map(([name, def]) => {
                    let sql = `${escapeIdentifier(name)} ${def.sqlType}`;
                    if (!def.nullable && !def.sqlType.includes('PRIMARY KEY')) sql += ' NOT NULL';
                    return sql;
                })
                .join(', ');
            return `CREATE TABLE IF NOT EXISTS ${escapeIdentifier(step.table)} (${cols})`;
        }
        default:
            throw new Error(`Unknown migration op: ${(step as any).op}`);
    }
}

/** Generate all SQL statements for a migration */
export function migrationToSQL(migration: Migration): string[] {
    return migration.steps.map(migrationStepToSQL);
}

/** Validate that a migration step is safe for cross-device compatibility */
export function validateMigrationStep(step: MigrationStep): { safe: boolean; reason?: string } {
    if (step.op === 'addColumn') {
        if (!step.nullable && step.default === undefined) {
            return {
                safe: false,
                reason: `addColumn '${step.column}' on '${step.table}' is NOT NULL without a default — older clients will fail to INSERT`,
            };
        }
    }
    return { safe: true };
}

/** Validate all steps in a migration */
export function validateMigration(migration: Migration): { safe: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const step of migration.steps) {
        const result = validateMigrationStep(step);
        if (!result.safe && result.reason) {
            errors.push(result.reason);
        }
    }
    return { safe: errors.length === 0, errors };
}
