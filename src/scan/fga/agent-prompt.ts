import type { DataModelDiscovery } from '../data-model/types.js';

export interface FgaScanPromptContext {
  /** Phase-1 discovery, already narrowed to the user's selected scope */
  dataModel: DataModelDiscovery;
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

export function buildFgaScanPrompt(context: FgaScanPromptContext): string {
  const { dataModel } = context;

  return `You are a WorkOS FGA modeling analyst. A discovery pass already inventoried this project's data model, and the user scoped the analysis to the entities below. Propose how to model THESE entities with WorkOS Fine-Grained Authorization.

${FGA_CONCEPTS}

## Scoped Data Model (discovered in phase 1, selected by the user)
${JSON.stringify(
  {
    source: dataModel.source,
    summary: dataModel.summary,
    domains: dataModel.domains,
    entities: dataModel.entities,
  },
  null,
  2,
)}

## Your Task
1. Use the scoped data model above as your ground truth. You MAY re-read the cited files
   (and explore with Glob/Grep) to understand fields, membership tables, and any existing
   authorization code — but do not expand the proposal beyond the scoped entities.
2. Decide which scoped entities should become FGA resource types and how they nest.
3. Propose roles scoped to those resource types, with permissions and cascade behavior.
4. Produce example access checks that demonstrate how cascading inheritance answers real
   authorization questions in this application.

Report progress with [STATUS] prefixed lines as you work (e.g. "[STATUS] Reading membership model").

## Output Format
End with your analysis as a JSON object wrapped in a markdown code block:
\`\`\`json
{
  "summary": "One paragraph: the shape of the proposed FGA model and why it fits this data model",
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
- Every resourceType's mappedEntities MUST name entities from the scoped data model above.
  No evidence — drop it.
- Every "parent" value MUST be the "type" of another resourceType in your proposal (or null).
- Do NOT model every entity as a resource type. Only entities that gate access belong in the
  hierarchy; aim for 2–4 levels.
- Do NOT invent entities, relationships, or existing authorization behavior you did not observe.
- If the scoped model has no plausible access-gating entities, return empty arrays and explain
  why in the summary — do not fabricate a proposal.
- Permissions use resource_type:action naming.
- You have read-only access (Read, Glob, Grep). Do not attempt to modify files or run commands.`;
}
