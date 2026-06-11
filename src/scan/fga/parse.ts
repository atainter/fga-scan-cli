import { extractJsonCandidates, parseFirstJsonObject } from '../json-extract.js';
import type {
  FgaAnalysis,
  FgaExampleCheck,
  FgaIntegrationSnippet,
  FgaRecommendation,
  FgaResourceTypeProposal,
  FgaRoleProposal,
} from './types.js';

const PRIORITIES = new Set(['high', 'medium', 'low']);

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
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

function normalizeSnippet(raw: Record<string, unknown>): FgaIntegrationSnippet {
  return {
    title: asString(raw.title),
    language: asString(raw.language, 'javascript'),
    code: asString(raw.code),
    appliesTo: typeof raw.appliesTo === 'string' && raw.appliesTo.length > 0 ? raw.appliesTo : undefined,
  };
}

/**
 * Parse the analysis agent's final output into a normalized FgaAnalysis.
 * Returns null when nothing parseable is found.
 */
export function parseFgaAgentOutput(text: string): FgaAnalysis | null {
  const parsed = parseFirstJsonObject(extractJsonCandidates(text, 'proposal'));
  if (!parsed) return null;

  const proposalRaw = (parsed.proposal ?? {}) as Record<string, unknown>;

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

  const integrationSnippets = Array.isArray(parsed.integrationSnippets)
    ? (parsed.integrationSnippets as Record<string, unknown>[]).map(normalizeSnippet).filter((s) => s.title && s.code)
    : [];

  return {
    summary: asString(parsed.summary),
    proposal: { resourceTypes, roles, exampleChecks },
    recommendations,
    integrationSnippets,
    warnings,
  };
}
