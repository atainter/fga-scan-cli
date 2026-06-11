import { synthesizeDomains } from '../domains.js';
import { normalizeDiscovery } from '../parse.js';
import type { DataModelDiscovery, DiscoveredEntity, EntityRelationship } from '../types.js';

/**
 * Neutral intermediate every deterministic parser targets — tables, columns,
 * and FK constraints. One shared converter (below) derives the
 * DataModelDiscovery from it, so relationship semantics (belongsTo vs hasOne,
 * join-table folding) are implemented exactly once. Mirrors how Liam ERD
 * keeps constraints in the schema model and derives relationships at the end.
 */
export interface RawColumn {
  name: string;
  /** Covered by a single-column unique constraint or unique index */
  unique?: boolean;
}

export interface RawForeignKey {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
}

export interface RawTable {
  name: string;
  filePath: string;
  description?: string;
  columns: RawColumn[];
  /** Primary key column names (composite supported) */
  pkColumns: string[];
}

export interface RawSchema {
  /** e.g. 'prisma', 'sql', 'rails', 'drizzle', 'dbml' */
  source: string;
  tables: RawTable[];
  foreignKeys: RawForeignKey[];
}

const TIMESTAMP_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'createdat',
  'updatedat',
  'deleted_at',
  'deletedat',
  'inserted_at',
]);

function isHousekeepingColumn(name: string): boolean {
  return TIMESTAMP_COLUMNS.has(name.toLowerCase()) || name.toLowerCase() === 'id';
}

/**
 * A pure join table carries nothing but its two FKs (plus id/timestamps).
 * Those fold into a single manyToMany edge. Tables with any payload column
 * (e.g. a membership `role`) stay as entities — FGA cares about those.
 */
function isPureJoinTable(table: RawTable, fks: RawForeignKey[]): boolean {
  if (fks.length !== 2) return false;
  const fkColumns = new Set(fks.flatMap((fk) => fk.fromColumns.map((c) => c.toLowerCase())));
  return table.columns.every((c) => fkColumns.has(c.name.toLowerCase()) || isHousekeepingColumn(c.name));
}

/** A FK whose columns are fully covered by a unique constraint or the PK is 1:1 */
function isUniqueFk(table: RawTable, fk: RawForeignKey): boolean {
  if (fk.fromColumns.length === 1) {
    const column = table.columns.find((c) => c.name === fk.fromColumns[0]);
    if (column?.unique) return true;
  }
  return (
    table.pkColumns.length === fk.fromColumns.length &&
    fk.fromColumns.every((c) => table.pkColumns.includes(c))
  );
}

/**
 * Derive a DataModelDiscovery from raw tables + FK constraints:
 *   FK → belongsTo (FK side), or hasOne when the FK columns are unique;
 *   pure join tables fold into one manyToMany edge and disappear as entities;
 *   domains come from relationship-graph connected components.
 */
export function rawSchemaToDiscovery(raw: RawSchema, summary?: string): DataModelDiscovery {
  const tablesByName = new Map(raw.tables.map((t) => [t.name, t]));
  const fksByTable = new Map<string, RawForeignKey[]>();
  for (const fk of raw.foreignKeys) {
    if (!tablesByName.has(fk.fromTable) || !tablesByName.has(fk.toTable)) continue;
    const list = fksByTable.get(fk.fromTable) ?? [];
    list.push(fk);
    fksByTable.set(fk.fromTable, list);
  }

  const joinTables = new Map<string, RawForeignKey[]>();
  for (const table of raw.tables) {
    const fks = fksByTable.get(table.name) ?? [];
    if (isPureJoinTable(table, fks)) {
      joinTables.set(table.name, fks);
    }
  }

  const relationshipsByEntity = new Map<string, EntityRelationship[]>();
  const addRelationship = (from: string, rel: EntityRelationship): void => {
    const list = relationshipsByEntity.get(from) ?? [];
    // Dedupe identical edges (e.g. repeated migrations re-adding a FK)
    if (!list.some((r) => r.to === rel.to && r.kind === rel.kind && r.via === rel.via)) {
      list.push(rel);
      relationshipsByEntity.set(from, list);
    }
  };

  for (const [tableName, fks] of fksByTable) {
    if (joinTables.has(tableName)) continue;
    const table = tablesByName.get(tableName)!;
    for (const fk of fks) {
      if (joinTables.has(fk.toTable)) continue;
      addRelationship(tableName, {
        to: fk.toTable,
        kind: isUniqueFk(table, fk) ? 'hasOne' : 'belongsTo',
        via: fk.fromColumns.join('+'),
      });
    }
  }

  // Fold each pure join table into a single manyToMany edge between its targets
  for (const [joinName, fks] of joinTables) {
    const [a, b] = [fks[0].toTable, fks[1].toTable];
    if (joinTables.has(a) || joinTables.has(b)) continue;
    const [from, to] = [a, b].sort();
    addRelationship(from, { to, kind: 'manyToMany', via: joinName });
  }

  const entities: DiscoveredEntity[] = raw.tables
    .filter((t) => !joinTables.has(t.name))
    .map((t) => ({
      name: t.name,
      filePath: t.filePath,
      description: t.description,
      relationships: relationshipsByEntity.get(t.name) ?? [],
    }));

  const edges = entities.flatMap((e) => e.relationships.map((r) => ({ from: e.name, to: r.to })));
  const domains = synthesizeDomains(
    entities.map((e) => e.name),
    edges,
  );

  // normalizeDiscovery applies the same integrity guarantees AI discovery
  // gets (referential filtering, "Other" domain for ungrouped entities).
  return normalizeDiscovery({
    source: raw.source,
    summary:
      summary ??
      `Parsed deterministically from ${raw.source}: ${entities.length} entities, ${edges.length} relationships.`,
    entities,
    domains,
  });
}
