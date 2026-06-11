import { readFile } from 'node:fs/promises';
import { normalizeDiscovery } from './parse.js';
import { synthesizeDomains } from './domains.js';
import type { DataModelDiscovery, EntityRelationship } from './types.js';

export const MODEL_ARTIFACT_KIND = 'workos-data-model';

/**
 * Versioned envelope written after discovery so a later run (or a teammate)
 * can skip the AI discovery passes entirely via `--model <path>`.
 */
export interface ModelArtifact {
  kind: typeof MODEL_ARTIFACT_KIND;
  version: 1;
  generatedAt: string;
  /** Project path the model was discovered from */
  project?: string;
  discovery: DataModelDiscovery;
}

export function serializeModelArtifact(discovery: DataModelDiscovery, project?: string): string {
  const artifact: ModelArtifact = {
    kind: MODEL_ARTIFACT_KIND,
    version: 1,
    generatedAt: new Date().toISOString(),
    project,
    discovery,
  };
  return JSON.stringify(artifact, null, 2);
}

/**
 * Mermaid erDiagram cardinality → relationship kind, read from the side
 * glyphs: a crow's foot (`{` / `}`) on a side means "many" on that side.
 *   A ||--o{ B  →  A hasMany B
 *   A }o--|| B  →  A belongsTo B
 *   A ||--|| B  →  hasOne
 *   A }o--o{ B  →  manyToMany
 */
function kindFromCardinality(cardinality: string): EntityRelationship['kind'] {
  const [left, right] = cardinality.split('--');
  if (!left || !right) return 'belongsTo';
  const leftMany = left.includes('}');
  const rightMany = right.includes('{');
  if (leftMany && rightMany) return 'manyToMany';
  if (leftMany) return 'belongsTo';
  if (rightMany) return 'hasMany';
  return 'hasOne';
}

const ER_RELATIONSHIP_LINE =
  /^\s*([A-Za-z][\w-]*)\s+([|}{o.]+--[|}{o.]+)\s+([A-Za-z][\w-]*)\s*(?::\s*"?([^"\n]*?)"?\s*)?$/;

/**
 * Parse a Mermaid `erDiagram` into a DataModelDiscovery. Handles bare entity
 * declarations, attribute blocks (skipped), relationship lines with labels,
 * and diagrams embedded in markdown code fences. Domains are synthesized from
 * the connected components of the relationship graph, each named after its
 * most-connected entity.
 */
export function parseMermaidErd(content: string, sourcePath: string): DataModelDiscovery | null {
  const startIdx = content.search(/\berDiagram\b/);
  if (startIdx === -1) return null;

  const lines = content.slice(startIdx).split('\n').slice(1);
  const entityNames = new Set<string>();
  const relationships: { from: string; rel: EntityRelationship }[] = [];

  let inAttributeBlock = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('```')) break; // end of a fenced markdown block
    if (inAttributeBlock) {
      if (line === '}') inAttributeBlock = false;
      continue;
    }
    if (line.length === 0 || line.startsWith('%%')) continue;

    const relMatch = line.match(ER_RELATIONSHIP_LINE);
    if (relMatch) {
      const [, from, cardinality, to, label] = relMatch;
      entityNames.add(from);
      entityNames.add(to);
      relationships.push({
        from,
        rel: { to, kind: kindFromCardinality(cardinality), via: label?.trim() || undefined },
      });
      continue;
    }

    // Entity declaration: `NAME` or `NAME {` (attribute block follows)
    const entityMatch = line.match(/^([A-Za-z][\w-]*)\s*(\{)?\s*$/);
    if (entityMatch) {
      entityNames.add(entityMatch[1]);
      if (entityMatch[2]) inAttributeBlock = true;
    }
  }

  if (entityNames.size === 0) return null;

  const domains = synthesizeDomains(
    [...entityNames],
    relationships.map((r) => ({ from: r.from, to: r.rel.to })),
  );

  return normalizeDiscovery({
    source: 'mermaid-erd',
    summary: `Imported from Mermaid ER diagram (${sourcePath}): ${entityNames.size} entities, ${relationships.length} relationships.`,
    entities: [...entityNames].sort().map((entityName) => ({
      name: entityName,
      filePath: sourcePath,
      relationships: relationships.filter((r) => r.from === entityName).map((r) => r.rel),
    })),
    domains,
  });
}

/**
 * Parse a model artifact's content. Accepts, in order of detection:
 *   1. Our versioned artifact envelope (saved by a previous scan)
 *   2. A raw discovery-shaped JSON object (hand-written is fine — entities
 *      missing a filePath default to the artifact path as their evidence)
 *   3. A Mermaid erDiagram (bare .mmd or embedded in markdown)
 */
export function parseModelArtifact(content: string, sourcePath: string): DataModelDiscovery {
  const trimmed = content.trim();

  if (trimmed.startsWith('{')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Could not parse ${sourcePath} as JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const candidate =
      parsed.kind === MODEL_ARTIFACT_KIND && parsed.discovery && typeof parsed.discovery === 'object'
        ? (parsed.discovery as Record<string, unknown>)
        : parsed;

    if (!Array.isArray(candidate.entities)) {
      throw new Error(`${sourcePath} does not look like a data model artifact (missing "entities" array)`);
    }

    // Hand-written artifacts may omit filePath — the artifact itself is the evidence
    for (const entity of candidate.entities as Record<string, unknown>[]) {
      if (entity && typeof entity === 'object' && typeof entity.filePath !== 'string') {
        entity.filePath = sourcePath;
      }
    }

    const discovery = normalizeDiscovery(candidate);
    if (discovery.entities.length === 0) {
      throw new Error(`${sourcePath} contained no valid entities`);
    }
    return { ...discovery, source: discovery.source ?? 'artifact' };
  }

  const fromMermaid = parseMermaidErd(content, sourcePath);
  if (fromMermaid) return fromMermaid;

  throw new Error(
    `Unrecognized model artifact format in ${sourcePath} — expected a data model JSON ` +
      `(from a previous scan) or a Mermaid erDiagram`,
  );
}

/** Read and parse a model artifact from disk. Throws with actionable messages. */
export async function loadModelArtifact(path: string): Promise<DataModelDiscovery> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    throw new Error(`Could not read model artifact at ${path}`);
  }
  return parseModelArtifact(content, path);
}
