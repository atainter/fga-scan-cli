import { dbmlDatabaseToDiscovery } from './sql.js';
import type { DataModelDiscovery } from '../types.js';

/**
 * Parse a DBML file via @dbml/core — the canonical dbdiagram.io engine.
 * DBML refs are first-class relationships, so this is the highest-fidelity
 * deterministic source we support.
 */
export async function parseDbml(filePath: string, content: string): Promise<DataModelDiscovery | null> {
  const { Parser } = await import('@dbml/core');

  let database: any;
  for (const format of ['dbmlv2', 'dbml'] as const) {
    try {
      database = (Parser as any).parse(content, format);
      break;
    } catch {
      // try the legacy parser next
    }
  }
  if (!database) return null;

  return dbmlDatabaseToDiscovery(database, 'dbml', filePath);
}
