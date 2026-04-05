// ── SQL generation utilities ────────────────────────────────────────────────
// Shared between store.ts (schema init) and migrations.ts (ALTER TABLE).
// All identifier/value interpolation goes through escaping helpers.

import type { TableDef } from './schema';

// ── Escaping ────────────────────────────────────────────────────────────────

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate and quote a SQL identifier (table or column name).
 * Rejects anything that isn't a simple alphanumeric+underscore name.
 */
export function escapeIdentifier(name: string): string {
    if (!IDENT_RE.test(name)) {
        throw new Error(`Invalid SQL identifier: "${name}"`);
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

/** Generate CREATE TABLE IF NOT EXISTS from a TableDef */
export function tableToCreateSQL(t: TableDef): string {
    const cols = Object.entries(t.columns)
        .map(([name, col]) => {
            // Primary keys get their full sqlType (e.g. "INTEGER PRIMARY KEY")
            let sql = `${escapeIdentifier(name)} ${col.sqlType}`;
            if (!col.nullable && !col.primaryKey) sql += ' NOT NULL';
            return sql;
        })
        .join(', ');
    return `CREATE TABLE IF NOT EXISTS ${escapeIdentifier(t.name)} (${cols});`;
}

/** Generate INSERT OR REPLACE from a TableDef */
export function tableToInsertSQL(t: TableDef): string {
    const colNames = Object.keys(t.columns);
    const quoted = colNames.map(escapeIdentifier).join(', ');
    const placeholders = colNames.map(() => '?').join(', ');
    return `INSERT OR REPLACE INTO ${escapeIdentifier(t.name)} (${quoted}) VALUES (${placeholders})`;
}
