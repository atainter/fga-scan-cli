import fg from 'fast-glob';
import type { DataModelHints, DataModelSourceHint } from './types.js';

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/vendor/**', '**/.next/**'];

/** Cap per source so a huge migrations directory can't flood the prompt */
const MAX_FILES_PER_SOURCE = 20;

interface SourcePattern {
  kind: string;
  patterns: string[];
}

const SOURCE_PATTERNS: SourcePattern[] = [
  { kind: 'prisma', patterns: ['**/schema.prisma', '**/prisma/schema/**/*.prisma'] },
  { kind: 'drizzle', patterns: ['**/drizzle.config.{ts,js,mjs}', '**/db/schema.{ts,js}', '**/db/schema/**/*.{ts,js}'] },
  { kind: 'typeorm', patterns: ['**/*.entity.{ts,js}'] },
  { kind: 'sql-migrations', patterns: ['**/migrations/**/*.sql', '**/migrate/**/*.sql'] },
  { kind: 'rails', patterns: ['db/schema.rb', 'app/models/**/*.rb'] },
  { kind: 'django', patterns: ['**/models.py', '**/models/**/*.py'] },
  { kind: 'graphql-schema', patterns: ['**/*.graphql', '**/*.graphqls', '**/schema.gql'] },
  { kind: 'mongoose', patterns: ['**/models/**/*.{ts,js}', '**/schemas/**/*.{ts,js}'] },
];

/**
 * Discover likely data-model definition files. These are hints for the scan
 * agent — it explores the project itself, but seeding known schema locations
 * keeps it from burning turns on discovery.
 */
export async function collectDataModelHints(installDir: string): Promise<DataModelHints> {
  const sources: DataModelSourceHint[] = [];

  for (const source of SOURCE_PATTERNS) {
    try {
      const files = await fg(source.patterns, {
        cwd: installDir,
        ignore: IGNORE,
        onlyFiles: true,
        deep: 6,
        dot: false,
        suppressErrors: true,
      });
      if (files.length > 0) {
        sources.push({ kind: source.kind, files: files.sort().slice(0, MAX_FILES_PER_SOURCE) });
      }
    } catch {
      // A failing glob shouldn't kill the scan — the agent can still explore
    }
  }

  return { sources };
}
