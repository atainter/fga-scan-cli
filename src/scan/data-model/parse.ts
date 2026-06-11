import { extractJsonCandidates, parseFirstJsonObject } from '../json-extract.js';
import type { DataModelDiscovery, DiscoveredDomain, DiscoveredEntity, EntityRelationship } from './types.js';

const RELATIONSHIP_KINDS = new Set(['belongsTo', 'hasMany', 'hasOne', 'manyToMany']);

function normalizeEntity(raw: Record<string, unknown>): DiscoveredEntity | null {
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null;
  // filePath is required evidence — an entity without one was likely invented
  if (typeof raw.filePath !== 'string' || raw.filePath.length === 0) return null;

  const relationships: EntityRelationship[] = Array.isArray(raw.relationships)
    ? (raw.relationships as Record<string, unknown>[])
        .filter((r) => r && typeof r === 'object' && typeof r.to === 'string')
        .map((r) => ({
          to: r.to as string,
          kind: RELATIONSHIP_KINDS.has(r.kind as string) ? (r.kind as EntityRelationship['kind']) : 'belongsTo',
          via: typeof r.via === 'string' ? r.via : undefined,
        }))
    : [];

  return {
    name: raw.name,
    filePath: raw.filePath,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    relationships,
  };
}

/**
 * Parse and normalize the discovery agent's output. Guarantees referential
 * integrity: relationships point at known entities, domains contain only
 * known entities, and every entity belongs to at least one domain (an
 * "Other" domain catches strays so the scoping picker always covers the
 * full model).
 */
export function parseDiscoveryOutput(text: string): DataModelDiscovery | null {
  const parsed = parseFirstJsonObject(extractJsonCandidates(text, 'entities'));
  if (!parsed) return null;
  return normalizeDiscovery(parsed);
}

/**
 * Normalize an already-parsed discovery-shaped object. Shared by the agent
 * output path above and `--model` artifact loading, so artifacts get the same
 * referential-integrity guarantees as live discovery.
 */
export function normalizeDiscovery(parsed: Record<string, unknown>): DataModelDiscovery {
  const entities = Array.isArray(parsed.entities)
    ? (parsed.entities as Record<string, unknown>[])
        .map(normalizeEntity)
        .filter((e): e is DiscoveredEntity => e !== null)
    : [];

  const known = new Set(entities.map((e) => e.name));
  for (const entity of entities) {
    entity.relationships = entity.relationships.filter((r) => known.has(r.to));
  }

  const domains: DiscoveredDomain[] = Array.isArray(parsed.domains)
    ? (parsed.domains as Record<string, unknown>[])
        .filter((d) => d && typeof d === 'object' && typeof d.name === 'string')
        .map((d) => ({
          name: d.name as string,
          description: typeof d.description === 'string' ? d.description : undefined,
          entities: Array.isArray(d.entities)
            ? (d.entities as unknown[]).filter((e): e is string => typeof e === 'string' && known.has(e))
            : [],
        }))
        .filter((d) => d.entities.length > 0)
    : [];

  const grouped = new Set(domains.flatMap((d) => d.entities));
  const strays = entities.filter((e) => !grouped.has(e.name)).map((e) => e.name);
  if (strays.length > 0) {
    domains.push({ name: 'Other', description: 'Entities not assigned to a domain', entities: strays });
  }

  return {
    source: typeof parsed.source === 'string' ? parsed.source : null,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    entities,
    domains,
  };
}
