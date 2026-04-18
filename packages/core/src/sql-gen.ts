// ── SQL generation utilities ────────────────────────────────────────────────
// Shared between store.ts (schema init) and migrations.ts (ALTER TABLE).
// All identifier/value interpolation goes through escaping helpers.

import type { AnyTable, ColumnDef } from './schema';
import { errors, SchemaCode } from './errors';

// ── Escaping ────────────────────────────────────────────────────────────────

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate and quote a SQL identifier (table or column name).
 * Rejects anything that isn't a simple alphanumeric+underscore name.
 */
export function escapeIdentifier(name: string): string {
    if (!IDENT_RE.test(name)) {
        throw errors.schema(SchemaCode.INVALID_SQL_IDENTIFIER, {
            message: `Invalid SQL identifier: "${name}"`,
            hint: `Use only letters, numbers, and underscores.`,
            context: { identifier: name },
        });
    }
    return `"${name}"`;
}

/**
 * Escape a literal value for use in a DEFAULT clause or similar.
 * Strings are single-quoted with internal quotes escaped.
 * Numbers/booleans pass through as-is.
 */
export function escapeLiteral(val: string | number | boolean): string {
    if (typeof val === 'string') {
        return `'${val.replace(/'/g, "''")}'`;
    }
    return String(val);
}

// ── Table DDL ───────────────────────────────────────────────────────────────

/** Generate `CREATE TABLE IF NOT EXISTS` from a Table. */
export function tableToCreateSQL(t: AnyTable): string {
    const cols = Object.entries(t.$columns)
        .map(([name, col]) => {
            const c = col as ColumnDef<unknown>;
            // Primary keys carry their full sqlType (e.g. "INTEGER PRIMARY KEY")
            let sql = `${escapeIdentifier(name)} ${c.sqlType}`;
            if (!c.nullable && !c.primaryKey) sql += ' NOT NULL';
            return sql;
        })
        .join(', ');
    return `CREATE TABLE IF NOT EXISTS ${escapeIdentifier(t.$name)} (${cols});`;
}

/** Generate `INSERT OR REPLACE` from a Table. */
export function tableToInsertSQL(t: AnyTable): string {
    const colNames = Object.keys(t.$columns);
    const quoted = colNames.map(escapeIdentifier).join(', ');
    const placeholders = colNames.map(() => '?').join(', ');
    return `INSERT OR REPLACE INTO ${escapeIdentifier(t.$name)} (${quoted}) VALUES (${placeholders})`;
}
