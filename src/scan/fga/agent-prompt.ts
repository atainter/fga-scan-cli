import type { LanguageInfo, FrameworkInfo } from '../../doctor/types.js';
import type { DataModelHints } from './types.js';

export interface FgaScanPromptContext {
  installDir: string;
  language: LanguageInfo;
  framework: FrameworkInfo;
  dataModelHints: DataModelHints;
}

const FGA_DOCS_URL = 'https://workos.com/docs/fga';

/**
 * Primer on WorkOS FGA concepts injected into the prompt so the agent grounds
 * its proposal in the actual product model rather than generic ReBAC theory.
 */
const FGA_CONCEPTS = `## WorkOS FGA Concepts (source of truth)

WorkOS Fine-Grained Authorization (FGA) models access control with four building blocks:

- **Subjects** — users, groups, and agents that are granted access. Subjects enter through
  organization memberships.
- **Resources** — the business entities access is granted on (e.g. workspace, project, app).
  Resources are arranged in a HIERARCHY: every resource type can declare a parent type, and
  resource instances form a tree.
- **Privileges (roles & permissions)** — roles are scoped to a specific resource type and bundle
  permissions. Permissions use \`resource_type:action\` naming (e.g. \`project:edit\`).
- **Assignments** — bindings that connect an organization membership (subject) to a role on a
  particular resource instance.

The defining feature is **cascading inheritance**: a role assigned at a resource cascades down
to all descendant resources automatically. An admin on a workspace gets admin on every project
and app nested under it — no per-child assignments needed. This is the main difference from
tenant-wide RBAC, where roles apply to the whole organization.

Good FGA models:
- Keep the hierarchy shallow (2–4 levels). Model only entities that gate access, not every table.
- Put the broadest roles high in the tree (organization/workspace admin) and narrow,
  member-style roles lower (project editor, app viewer).
- Map multi-tenancy boundaries (the "organization"/"team"/"account" table) to the root
  resource type.
- Leave out pure data tables (audit rows, join tables, settings blobs) — they inherit access
  from their owning resource.

Docs: ${FGA_DOCS_URL}`;

function formatHints(hints: DataModelHints): string {
  if (hints.sources.length === 0) {
    return 'No schema files were pre-detected. Explore the project to find where persistent entities are defined.';
  }
  return hints.sources
    .map((s) => `- ${s.kind}:\n${s.files.map((f) => `  - ${f}`).join('\n')}`)
    .join('\n');
}

export function buildFgaScanPrompt(context: FgaScanPromptContext): string {
  const { language, framework, dataModelHints } = context;

  const projectContext = [
    `- Language: ${language.name}`,
    framework.name ? `- Framework: ${framework.name} ${framework.version ?? ''}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `You are a WorkOS FGA modeling analyst. Explore this project's data model and propose how to model it with WorkOS Fine-Grained Authorization.

## Project Context
${projectContext}

${FGA_CONCEPTS}

## Pre-detected Schema Files
${formatHints(dataModelHints)}

## Your Task
1. Read the schema/model files above (and explore further with Glob/Grep if needed) to understand
   the persistent entities and their relationships. Look for: the multi-tenancy boundary
   (organizations/teams/accounts), containment relationships (workspace → project → resource),
   membership/role tables, and any existing authorization code (role checks, permission middleware).
2. Identify which entities should become FGA resource types and how they nest.
3. Propose roles scoped to those resource types, with permissions and cascade behavior.
4. Produce example access checks that demonstrate how cascading inheritance answers real
   authorization questions in this application.

Report progress with [STATUS] prefixed lines as you work (e.g. "[STATUS] Reading Prisma schema").

## Output Format
End with your analysis as a JSON object wrapped in a markdown code block:
\`\`\`json
{
  "summary": "One paragraph: what the app's data model looks like and the shape of the proposed FGA model",
  "dataModel": {
    "source": "prisma | drizzle | typeorm | sql | rails | django | other",
    "entities": [
      {
        "name": "EntityName",
        "filePath": "path/to/definition",
        "description": "What this entity represents",
        "relationships": [{ "to": "OtherEntity", "kind": "belongsTo | hasMany | hasOne | manyToMany", "via": "foreign key or join table" }]
      }
    ]
  },
  "proposal": {
    "resourceTypes": [
      {
        "type": "organization",
        "displayName": "Organization",
        "parent": null,
        "mappedEntities": ["EntityName"],
        "rationale": "Why this entity is a resource type and why it sits at this level"
      }
    ],
    "roles": [
      {
        "name": "admin",
        "resourceType": "organization",
        "permissions": ["project:create", "project:delete"],
        "cascades": true,
        "rationale": "Why this role exists at this level"
      }
    ],
    "exampleChecks": [
      {
        "description": "Org admin can edit a nested project",
        "subject": "user:alice",
        "permission": "project:edit",
        "resource": "project:atlas",
        "expected": true,
        "path": "alice has admin on organization:acme → cascades to project:atlas"
      }
    ]
  },
  "recommendations": [
    { "title": "Short title", "detail": "Actionable guidance", "priority": "high | medium | low" }
  ],
  "warnings": ["Anything ambiguous or risky about the proposal"]
}
\`\`\`

## Rules
- Every resourceType MUST list mappedEntities that actually exist in the data model you read,
  and every entity MUST cite the filePath where you found it. No evidence — drop it.
- Every "parent" value MUST be the "type" of another resourceType in your proposal (or null).
- Do NOT model every table as a resource type. Only entities that gate access belong in the
  hierarchy; aim for 2–4 levels.
- Do NOT invent entities, relationships, or existing authorization behavior you did not observe
  in the code.
- If the project has no discernible data model, return empty arrays and explain why in the
  summary — do not fabricate a proposal.
- Permissions use resource_type:action naming.
- You have read-only access (Read, Glob, Grep). Do not attempt to modify files or run commands.`;
}
