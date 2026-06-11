import type { LanguageInfo, FrameworkInfo } from '../../doctor/types.js';
import type { DataModelHints } from '../fga/types.js';

export interface DiscoveryPromptContext {
  language: LanguageInfo;
  framework: FrameworkInfo;
  dataModelHints: DataModelHints;
  /**
   * When set, the deep discovery pass inventories ONLY these entities (plus
   * their relationships) instead of the whole model. Used after the user has
   * picked a domain so relationship extraction is scoped, not repo-wide.
   */
  focusEntities?: string[];
}

function formatHints(hints: DataModelHints): string {
  if (hints.sources.length === 0) {
    return 'No schema files were pre-detected. Explore the project to find where persistent entities are defined.';
  }
  return hints.sources
    .map((s) => `- ${s.kind}:\n${s.files.map((f) => `  - ${f}`).join('\n')}`)
    .join('\n');
}

/**
 * Phase-1 prompt: extract the data model only. No FGA reasoning happens here —
 * the output feeds an interactive scoping step before any authorization
 * analysis runs.
 */
export function buildDiscoveryPrompt(context: DiscoveryPromptContext): string {
  const { language, framework, dataModelHints, focusEntities } = context;

  const projectContext = [
    `- Language: ${language.name}`,
    framework.name ? `- Framework: ${framework.name} ${framework.version ?? ''}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const focusBlock =
    focusEntities && focusEntities.length > 0
      ? `\n## Focus\nThe user narrowed the scan to one domain. Inventory these entities, their relationships, AND
every ancestor entity on the path UP to the tenant root (the organization / workspace / account /
team table that owns everything). Those intermediate ancestors are needed so the FGA hierarchy
stays connected from the organization down to the domain — include them even though they sit
outside the chosen domain. Do NOT inventory unrelated entities from other domains:
${focusEntities.map((e) => `- ${e}`).join('\n')}\n`
      : '';

  return `You are a data-model analyst. Explore this project and produce an accurate inventory of its persistent data model. Do NOT analyze authorization yet — this is a pure discovery pass.

## Project Context
${projectContext}

## Pre-detected Schema Files
${formatHints(dataModelHints)}
${focusBlock}
## Your Task
1. Read the schema/model files above first. Only fall back to Glob/Grep if those files are missing
   or clearly incomplete — do not crawl the whole repository. Identify the persistent entities${
     focusEntities && focusEntities.length > 0 ? ' in the Focus list above' : ''
   }:
   database tables, ORM models, document collections.
2. Capture each entity's relationships (foreign keys, associations, join tables).
3. Group the entities into logical DOMAINS — cohesive functional areas like "Billing",
   "Projects", "Identity & Access", "Content". Domains let the user narrow the scan to one part
   of their application, so prefer 3–8 meaningful groups over one giant bucket.

Report progress with [STATUS] prefixed lines as you work (e.g. "[STATUS] Reading Prisma schema").

## Output Format
End with your inventory as a JSON object wrapped in a markdown code block:
\`\`\`json
{
  "source": "prisma | drizzle | typeorm | sql | rails | django | mongoose | other",
  "summary": "One paragraph: what this application stores and how the model is organized",
  "entities": [
    {
      "name": "Project",
      "filePath": "prisma/schema.prisma",
      "description": "What this entity represents in the product",
      "relationships": [
        { "to": "Organization", "kind": "belongsTo | hasMany | hasOne | manyToMany", "via": "organizationId" }
      ]
    }
  ],
  "domains": [
    { "name": "Projects", "description": "Project tracking and collaboration", "entities": ["Project", "Task"] }
  ]
}
\`\`\`

## Rules
- Every entity MUST cite the filePath where it is defined. No evidence — drop it.
- Every relationship's "to" MUST name another entity in your list.
- Every domain's "entities" MUST name entities in your list, and every entity SHOULD appear in
  exactly one domain.
- Report what you OBSERVED. Do not invent entities, fields, or relationships.
- Include join tables only when they carry meaning (e.g. a membership table with a role column);
  fold pure join tables into a manyToMany relationship instead.
- If the project has no discernible data model, return empty arrays and explain why in the summary.
- You have read-only access (Read, Glob, Grep). Do not attempt to modify files or run commands.`;
}

/**
 * Phase-1a prompt: a CHEAP outline pass. Lists entities (names + file paths
 * only) and groups them into domains so the user can pick a domain BEFORE the
 * expensive relationship-extraction + FGA reasoning runs. Deliberately skips
 * relationships and descriptions to keep token spend down — the focused deep
 * pass (buildDiscoveryPrompt with focusEntities) fills those in for the chosen
 * domain only.
 */
export function buildDomainOutlinePrompt(context: DiscoveryPromptContext): string {
  const { language, framework, dataModelHints } = context;

  const projectContext = [
    `- Language: ${language.name}`,
    framework.name ? `- Framework: ${framework.name} ${framework.version ?? ''}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `You are a data-model analyst doing a FAST first pass. List this project's persistent entities and group them into domains so a user can choose which part of the app to analyze. Do NOT extract relationships, fields, or authorization — keep this cheap.

## Project Context
${projectContext}

## Pre-detected Schema Files
${formatHints(dataModelHints)}

## Your Task
1. Read the schema/model files above. Only fall back to Glob/Grep if those files are missing or
   clearly incomplete — do NOT crawl the whole repository.
2. List every persistent entity by name and the file it is defined in. Nothing else — no
   relationships, no fields, no descriptions per entity.
3. Group the entities into logical DOMAINS — cohesive functional areas like "Billing", "Projects",
   "Identity & Access", "Content". Prefer 3–8 meaningful groups over one giant bucket; give each a
   one-line description so the user knows what they're picking.

Report progress with [STATUS] prefixed lines (e.g. "[STATUS] Listing Prisma models").

## Output Format
End with your outline as a JSON object wrapped in a markdown code block:
\`\`\`json
{
  "source": "prisma | drizzle | typeorm | sql | rails | django | mongoose | other",
  "summary": "One paragraph: what this application stores and how the model is organized",
  "entities": [
    { "name": "Project", "filePath": "prisma/schema.prisma" }
  ],
  "domains": [
    { "name": "Projects", "description": "Project tracking and collaboration", "entities": ["Project", "Task"] }
  ]
}
\`\`\`

## Rules
- Every entity MUST cite the filePath where it is defined. No evidence — drop it.
- Every domain's "entities" MUST name entities in your list, and every entity SHOULD appear in
  exactly one domain.
- Do NOT include a "relationships" field — that is the next pass's job.
- Report what you OBSERVED. Do not invent entities.
- If the project has no discernible data model, return empty arrays and explain why in the summary.
- You have read-only access (Read, Glob, Grep). Do not attempt to modify files or run commands.`;
}
