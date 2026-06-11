import type {
  FgaAnalysis,
  FgaDetectedEntity,
  FgaEntityRelationship,
  FgaExampleCheck,
  FgaRecommendation,
  FgaResourceTypeProposal,
  FgaRoleProposal,
} from './types.js';

const RELATIONSHIP_KINDS = new Set(['belongsTo', 'hasMany', 'hasOne', 'manyToMany']);
const PRIORITIES = new Set(['high', 'medium', 'low']);

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function normalizeEntity(raw: Record<string, unknown>): FgaDetectedEntity {
  const relationships: FgaEntityRelationship[] = Array.isArray(raw.relationships)
    ? (raw.relationships as Record<string, unknown>[])
        .filter((r) => r && typeof r === 'object' && typeof r.to === 'string')
        .map((r) => ({
          to: r.to as string,
          kind: RELATIONSHIP_KINDS.has(r.kind as string)
            ? (r.kind as FgaEntityRelationship['kind'])
            : 'belongsTo',
          via: typeof r.via === 'string' ? r.via : undefined,
        }))
    : [];

  return {
    name: asString(raw.name),
    filePath: typeof raw.filePath === 'string' ? raw.filePath : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    relationships,
  };
}

function normalizeResourceType(raw: Record<string, unknown>): FgaResourceTypeProposal {
  return {
    type: asString(raw.type),
    displayName: asString(raw.displayName, asString(raw.type)),
    parent: typeof raw.parent === 'string' && raw.parent.length > 0 ? raw.parent : null,
    mappedEntities: asStringArray(raw.mappedEntities),
    rationale: asString(raw.rationale),
  };
}

function normalizeRole(raw: Record<string, unknown>): FgaRoleProposal {
  return {
    name: asString(raw.name),
    resourceType: asString(raw.resourceType),
    permissions: asStringArray(raw.permissions),
    cascades: raw.cascades === true,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : undefined,
  };
}

function normalizeCheck(raw: Record<string, unknown>): FgaExampleCheck {
  return {
    description: asString(raw.description),
    subject: asString(raw.subject),
    permission: asString(raw.permission),
    resource: asString(raw.resource),
    expected: raw.expected !== false,
    path: typeof raw.path === 'string' ? raw.path : undefined,
  };
}

function normalizeRecommendation(raw: Record<string, unknown>): FgaRecommendation {
  return {
    title: asString(raw.title),
    detail: asString(raw.detail),
    priority: PRIORITIES.has(raw.priority as string) ? (raw.priority as FgaRecommendation['priority']) : 'medium',
  };
}

function normalizeAnalysis(parsed: Record<string, unknown>): FgaAnalysis {
  const dataModelRaw = (parsed.dataModel ?? {}) as Record<string, unknown>;
  const proposalRaw = (parsed.proposal ?? {}) as Record<string, unknown>;

  const entities = Array.isArray(dataModelRaw.entities)
    ? (dataModelRaw.entities as Record<string, unknown>[]).map(normalizeEntity).filter((e) => e.name)
    : [];

  const resourceTypes = Array.isArray(proposalRaw.resourceTypes)
    ? (proposalRaw.resourceTypes as Record<string, unknown>[]).map(normalizeResourceType).filter((r) => r.type)
    : [];

  const warnings = asStringArray(parsed.warnings);

  // Hierarchy integrity: a parent must reference another proposed type.
  // Dangling parents become roots so the diagram and tree renderers never
  // chase a missing node.
  const knownTypes = new Set(resourceTypes.map((r) => r.type));
  for (const rt of resourceTypes) {
    if (rt.parent && !knownTypes.has(rt.parent)) {
      warnings.push(`Resource type "${rt.type}" referenced unknown parent "${rt.parent}" — treated as a root.`);
      rt.parent = null;
    }
  }

  const roles = Array.isArray(proposalRaw.roles)
    ? (proposalRaw.roles as Record<string, unknown>[]).map(normalizeRole).filter((r) => r.name && r.resourceType)
    : [];

  const exampleChecks = Array.isArray(proposalRaw.exampleChecks)
    ? (proposalRaw.exampleChecks as Record<string, unknown>[]).map(normalizeCheck).filter((c) => c.description)
    : [];

  const recommendations = Array.isArray(parsed.recommendations)
    ? (parsed.recommendations as Record<string, unknown>[]).map(normalizeRecommendation).filter((r) => r.title)
    : [];

  return {
    summary: asString(parsed.summary),
    dataModel: {
      source: typeof dataModelRaw.source === 'string' ? dataModelRaw.source : null,
      entities,
    },
    proposal: { resourceTypes, roles, exampleChecks },
    recommendations,
    warnings,
  };
}

/**
 * Parse the agent's final output into a normalized FgaAnalysis.
 * The agent emits progress text before the final fenced JSON block, so we
 * take the LAST fenced block. Returns null when nothing parseable is found.
 */
export function parseFgaAgentOutput(text: string): FgaAnalysis | null {
  const fencedBlocks = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g)];
  const candidates: string[] = [];

  if (fencedBlocks.length > 0) {
    candidates.push(fencedBlocks[fencedBlocks.length - 1][1]);
  }
  // Fallback: a bare JSON object containing "proposal" somewhere in the text
  const bareMatch = text.match(/\{[\s\S]*"proposal"[\s\S]*\}/);
  if (bareMatch) {
    candidates.push(bareMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object') {
        return normalizeAnalysis(parsed as Record<string, unknown>);
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}
