import type { LanguageInfo, FrameworkInfo } from '../../doctor/types.js';
import type { DataModelHints } from '../fga/types.js';

export interface DiscoveryPromptContext {
  language: LanguageInfo;
  framework: FrameworkInfo;
  dataModelHints: DataModelHints;
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
  const { language, framework, dataModelHints } = context;

  const projectContext = [
    `- Language: ${language.name}`,
    framework.name ? `- Framework: ${framework.name} ${framework.version ?? ''}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `You are a data-model analyst. Explore this project and produce an accurate inventory of its persistent data model. Do NOT analyze authorization yet — this is a pure discovery pass.

## Project Context
${projectContext}

## Pre-detected Schema Files
${formatHints(dataModelHints)}

## Your Task
1. Read the schema/model files above (explore further with Glob/Grep if needed) and identify every
   persistent entity: database tables, ORM models, document collections.
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
