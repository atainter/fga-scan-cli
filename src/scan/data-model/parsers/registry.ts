import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePrismaSchema } from './prisma.js';
import { parseDrizzleSnapshot } from './drizzle-snapshot.js';
import { parseSchemaRb } from './schemarb.js';
import { parseDbml } from './dbml.js';
import { parsePostgresSql, parseMysqlSql } from './sql.js';
import type { DataModelDiscovery } from '../types.js';
import type { DataModelHints } from '../../fga/types.js';

export interface DeterministicParseResult {
  discovery: DataModelDiscovery;
  /** Which parser produced the model: 'prisma' | 'drizzle-snapshot' | 'rails' | 'dbml' | 'sql' */
  parser: string;
  /** Relative paths of the files that were parsed */
  files: string[];
}

async function readFiles(installDir: string, relativePaths: string[]): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];
  for (const relativePath of relativePaths) {
    try {
      files.push({ path: relativePath, content: await readFile(join(installDir, relativePath), 'utf-8') });
    } catch {
      // unreadable file — skip
    }
  }
  return files;
}

function hintFiles(hints: DataModelHints, kind: string): string[] {
  return hints.sources.find((s) => s.kind === kind)?.files ?? [];
}

/**
 * Try to parse the project's data model WITHOUT AI, using the pre-detected
 * schema files. Parsers are tried in fidelity order; the first one that
 * yields entities wins. Returns null when no deterministic source worked —
 * callers fall back to AI discovery.
 */
export async function parseDataModelDeterministically(
  installDir: string,
  hints: DataModelHints,
): Promise<DeterministicParseResult | null> {
  // 1. Prisma — single declarative DSL, highest hit-rate in JS repos
  const prismaPaths = hintFiles(hints, 'prisma');
  if (prismaPaths.length > 0) {
    const files = await readFiles(installDir, prismaPaths);
    const discovery = tryParse(() => parsePrismaSchema(files));
    if (discovery) return { discovery, parser: 'prisma', files: files.map((f) => f.path) };
  }

  // 2. Drizzle migration snapshot — full schema as JSON; use the latest one
  const snapshotPaths = hintFiles(hints, 'drizzle-snapshot').sort();
  const latestSnapshot = snapshotPaths[snapshotPaths.length - 1];
  if (latestSnapshot) {
    const [file] = await readFiles(installDir, [latestSnapshot]);
    if (file) {
      const discovery = tryParse(() => parseDrizzleSnapshot(file.path, file.content));
      if (discovery) return { discovery, parser: 'drizzle-snapshot', files: [file.path] };
    }
  }

  // 3. Rails schema.rb — the whole normalized schema in one generated file
  const schemaRbPath = hintFiles(hints, 'rails').find((f) => f.endsWith('db/schema.rb') || f === 'db/schema.rb');
  if (schemaRbPath) {
    const [file] = await readFiles(installDir, [schemaRbPath]);
    if (file) {
      const discovery = tryParse(() => parseSchemaRb(file.path, file.content));
      if (discovery) return { discovery, parser: 'rails', files: [file.path] };
    }
  }

  // 4. DBML — a hand-authored ER definition; first-class relationships
  for (const dbmlPath of hintFiles(hints, 'dbml')) {
    const [file] = await readFiles(installDir, [dbmlPath]);
    if (file) {
      const discovery = await tryParseAsync(() => parseDbml(file.path, file.content));
      if (discovery) return { discovery, parser: 'dbml', files: [file.path] };
    }
  }

  // 5. Raw SQL migrations — Postgres first, then the MySQL importer
  const sqlPaths = hintFiles(hints, 'sql-migrations');
  if (sqlPaths.length > 0) {
    const files = await readFiles(installDir, sqlPaths);
    if (files.length > 0) {
      const fromPg = tryParse(() => parsePostgresSql(files));
      if (fromPg) return { discovery: fromPg, parser: 'sql', files: files.map((f) => f.path) };
      const fromMysql = await tryParseAsync(() => parseMysqlSql(files));
      if (fromMysql) return { discovery: fromMysql, parser: 'sql', files: files.map((f) => f.path) };
    }
  }

  return null;
}

function tryParse(fn: () => DataModelDiscovery | null): DataModelDiscovery | null {
  try {
    const discovery = fn();
    return discovery && discovery.entities.length > 0 ? discovery : null;
  } catch {
    return null;
  }
}

async function tryParseAsync(fn: () => Promise<DataModelDiscovery | null>): Promise<DataModelDiscovery | null> {
  try {
    const discovery = await fn();
    return discovery && discovery.entities.length > 0 ? discovery : null;
  } catch {
    return null;
  }
}
