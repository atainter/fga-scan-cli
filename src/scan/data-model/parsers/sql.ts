import { parse as parsePgSql, type Statement } from 'pgsql-ast-parser';
import { rawSchemaToDiscovery, type RawForeignKey, type RawSchema, type RawTable } from './raw-schema.js';
import type { DataModelDiscovery } from '../types.js';

interface SqlFile {
  path: string;
  content: string;
}

/** Tolerant name accessor — pgsql-ast names are `{ name: string }` nodes */
function nameOf(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const name = (node as Record<string, unknown>).name;
  return typeof name === 'string' ? name : null;
}

function namesOf(nodes: unknown): string[] {
  return Array.isArray(nodes) ? nodes.map(nameOf).filter((n): n is string => n !== null) : [];
}

/**
 * Fold a sequence of Postgres DDL statements (across migration files, in
 * filename order) into a RawSchema. Handles: CREATE TABLE (with inline
 * REFERENCES / table-level FOREIGN KEY / PRIMARY KEY / UNIQUE), ALTER TABLE
 * ADD CONSTRAINT / ADD COLUMN, CREATE UNIQUE INDEX, DROP TABLE. Everything
 * else is ignored.
 */
function applyPgStatement(
  statement: Statement,
  filePath: string,
  tables: Map<string, RawTable>,
  foreignKeys: RawForeignKey[],
): void {
  const s = statement as unknown as Record<string, any>;

  if (s.type === 'create table') {
    const tableName = nameOf(s.name);
    if (!tableName) return;
    const table: RawTable = { name: tableName, filePath, columns: [], pkColumns: [] };

    for (const col of s.columns ?? []) {
      if (col.kind !== 'column') continue;
      const columnName = nameOf(col.name);
      if (!columnName) continue;
      let unique = false;
      for (const constraint of col.constraints ?? []) {
        if (constraint.type === 'unique') unique = true;
        if (constraint.type === 'primary key') table.pkColumns.push(columnName);
        if (constraint.type === 'reference') {
          const toTable = nameOf(constraint.foreignTable);
          if (toTable) {
            foreignKeys.push({
              fromTable: tableName,
              fromColumns: [columnName],
              toTable,
              toColumns: namesOf(constraint.foreignColumns),
            });
          }
        }
      }
      table.columns.push({ name: columnName, unique });
    }

    for (const constraint of s.constraints ?? []) {
      if (constraint.type === 'foreign key') {
        const toTable = nameOf(constraint.foreignTable);
        if (toTable) {
          foreignKeys.push({
            fromTable: tableName,
            fromColumns: namesOf(constraint.localColumns),
            toTable,
            toColumns: namesOf(constraint.foreignColumns),
          });
        }
      }
      if (constraint.type === 'primary key') {
        table.pkColumns.push(...namesOf(constraint.columns));
      }
      if (constraint.type === 'unique' && (constraint.columns ?? []).length === 1) {
        const columnName = namesOf(constraint.columns)[0];
        const column = table.columns.find((c) => c.name === columnName);
        if (column) column.unique = true;
      }
    }

    tables.set(tableName, table);
    return;
  }

  if (s.type === 'alter table') {
    const tableName = nameOf(s.table);
    if (!tableName) return;
    const table = tables.get(tableName);
    const changes = Array.isArray(s.changes) ? s.changes : s.change ? [s.change] : [];
    for (const change of changes) {
      if (change.type === 'add constraint' && change.constraint?.type === 'foreign key') {
        const toTable = nameOf(change.constraint.foreignTable);
        if (toTable) {
          foreignKeys.push({
            fromTable: tableName,
            fromColumns: namesOf(change.constraint.localColumns),
            toTable,
            toColumns: namesOf(change.constraint.foreignColumns),
          });
        }
      }
      if (change.type === 'add constraint' && change.constraint?.type === 'unique' && table) {
        const cols = namesOf(change.constraint.columns);
        if (cols.length === 1) {
          const column = table.columns.find((c) => c.name === cols[0]);
          if (column) column.unique = true;
        }
      }
      if (change.type === 'add column' && table) {
        const columnName = nameOf(change.column?.name);
        if (columnName && !table.columns.some((c) => c.name === columnName)) {
          let unique = false;
          for (const constraint of change.column?.constraints ?? []) {
            if (constraint.type === 'unique') unique = true;
            if (constraint.type === 'reference') {
              const toTable = nameOf(constraint.foreignTable);
              if (toTable) {
                foreignKeys.push({
                  fromTable: tableName,
                  fromColumns: [columnName],
                  toTable,
                  toColumns: namesOf(constraint.foreignColumns),
                });
              }
            }
          }
          table.columns.push({ name: columnName, unique });
        }
      }
    }
    return;
  }

  if (s.type === 'create index' && s.unique === true && (s.expressions ?? []).length === 1) {
    const tableName = nameOf(s.table);
    const expr = s.expressions[0]?.expression;
    const columnName = expr?.type === 'ref' ? expr.name : null;
    const table = tableName ? tables.get(tableName) : undefined;
    const column = table?.columns.find((c) => c.name === columnName);
    if (column) column.unique = true;
    return;
  }

  if (s.type === 'drop table') {
    for (const target of s.names ?? []) {
      const tableName = nameOf(target);
      if (tableName) tables.delete(tableName);
    }
  }
}

/** Parse a file's statements, falling back to per-statement chunks on error */
function pgStatements(content: string): Statement[] {
  try {
    return parsePgSql(content);
  } catch {
    const statements: Statement[] = [];
    for (const chunk of content.split(';')) {
      if (!chunk.trim()) continue;
      try {
        statements.push(...parsePgSql(chunk + ';'));
      } catch {
        // exotic statement (function body, COPY, dialect quirk) — skip it
      }
    }
    return statements;
  }
}

export function parsePostgresSql(files: SqlFile[]): DataModelDiscovery | null {
  const tables = new Map<string, RawTable>();
  const foreignKeys: RawForeignKey[] = [];

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const statement of pgStatements(file.content)) {
      try {
        applyPgStatement(statement, file.path, tables, foreignKeys);
      } catch {
        // tolerate AST shape surprises on individual statements
      }
    }
  }

  if (tables.size === 0) return null;
  const raw: RawSchema = { source: 'sql', tables: [...tables.values()], foreignKeys };
  return rawSchemaToDiscovery(raw);
}

/**
 * MySQL fallback via @dbml/core's importer (the dbdiagram.io engine).
 * Dynamic import keeps the 36MB dependency off the hot path.
 */
export async function parseMysqlSql(files: SqlFile[]): Promise<DataModelDiscovery | null> {
  const { Parser } = await import('@dbml/core');
  const combined = files
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => f.content)
    .join('\n\n');

  let database: any;
  try {
    database = (Parser as any).parse(combined, 'mysql');
  } catch {
    return null;
  }
  const filePath = files[0]?.path ?? 'schema.sql';
  return dbmlDatabaseToDiscovery(database, 'sql', filePath);
}

/**
 * Convert a @dbml/core Database model into a discovery via RawSchema.
 * Shared with the DBML parser. Endpoint `relation` is '1' or '*' — the
 * '*' side is the FK (child) side.
 */
export function dbmlDatabaseToDiscovery(
  database: any,
  source: string,
  filePath: string,
): DataModelDiscovery | null {
  const tables: RawTable[] = [];
  const foreignKeys: RawForeignKey[] = [];

  for (const schema of database?.schemas ?? []) {
    for (const table of schema.tables ?? []) {
      const raw: RawTable = { name: table.name, filePath, columns: [], pkColumns: [] };
      for (const field of table.fields ?? []) {
        raw.columns.push({ name: field.name, unique: field.unique === true });
        if (field.pk === true) raw.pkColumns.push(field.name);
      }
      tables.push(raw);
    }

    for (const ref of schema.refs ?? []) {
      const endpoints = ref.endpoints ?? [];
      if (endpoints.length !== 2) continue;
      // The many ('*') side carries the FK; for 1-1 refs take the first side
      const childIdx = endpoints.findIndex((e: any) => e.relation === '*');
      const child = endpoints[childIdx === -1 ? 0 : childIdx];
      const parent = endpoints[childIdx === -1 ? 1 : 1 - childIdx];
      if (!child?.tableName || !parent?.tableName) continue;
      foreignKeys.push({
        fromTable: child.tableName,
        fromColumns: child.fieldNames ?? [],
        toTable: parent.tableName,
        toColumns: parent.fieldNames ?? [],
      });
      // 1-1 ref: mark the FK column unique so the converter derives hasOne
      if (childIdx === -1) {
        const table = tables.find((t) => t.name === child.tableName);
        const column = table?.columns.find((c) => c.name === (child.fieldNames ?? [])[0]);
        if (column) column.unique = true;
      }
    }
  }

  if (tables.length === 0) return null;
  return rawSchemaToDiscovery({ source, tables, foreignKeys });
}
