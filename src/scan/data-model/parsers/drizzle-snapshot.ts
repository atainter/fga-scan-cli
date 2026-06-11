import { rawSchemaToDiscovery, type RawForeignKey, type RawSchema, type RawTable } from './raw-schema.js';
import type { DataModelDiscovery } from '../types.js';

/**
 * Parse a drizzle-kit migration snapshot (`drizzle/meta/NNNN_snapshot.json`).
 * The snapshot is the full schema as plain JSON — no TypeScript parsing and
 * no code execution needed. Callers should pass the highest-numbered
 * (latest) snapshot.
 */
export function parseDrizzleSnapshot(filePath: string, content: string): DataModelDiscovery | null {
  let snapshot: Record<string, any>;
  try {
    snapshot = JSON.parse(content);
  } catch {
    return null;
  }

  const snapshotTables = snapshot?.tables;
  if (!snapshotTables || typeof snapshotTables !== 'object') return null;

  const tables: RawTable[] = [];
  const foreignKeys: RawForeignKey[] = [];

  for (const tableDef of Object.values(snapshotTables) as Record<string, any>[]) {
    if (!tableDef?.name) continue;
    const table: RawTable = { name: tableDef.name, filePath, columns: [], pkColumns: [] };

    for (const column of Object.values(tableDef.columns ?? {}) as Record<string, any>[]) {
      if (!column?.name) continue;
      table.columns.push({ name: column.name, unique: column.isUnique === true });
      if (column.primaryKey === true) table.pkColumns.push(column.name);
    }

    for (const pk of Object.values(tableDef.compositePrimaryKeys ?? {}) as Record<string, any>[]) {
      table.pkColumns.push(...((pk?.columns as string[]) ?? []));
    }

    for (const unique of Object.values(tableDef.uniqueConstraints ?? {}) as Record<string, any>[]) {
      const cols = (unique?.columns as string[]) ?? [];
      if (cols.length === 1) {
        const column = table.columns.find((c) => c.name === cols[0]);
        if (column) column.unique = true;
      }
    }

    for (const fk of Object.values(tableDef.foreignKeys ?? {}) as Record<string, any>[]) {
      if (!fk?.tableFrom || !fk?.tableTo) continue;
      foreignKeys.push({
        fromTable: fk.tableFrom,
        fromColumns: (fk.columnsFrom as string[]) ?? [],
        toTable: fk.tableTo,
        toColumns: (fk.columnsTo as string[]) ?? [],
      });
    }

    tables.push(table);
  }

  if (tables.length === 0) return null;
  const raw: RawSchema = { source: 'drizzle', tables, foreignKeys };
  return rawSchemaToDiscovery(raw);
}
