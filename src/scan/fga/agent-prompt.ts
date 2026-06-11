import type { DataModelDiscovery, ScopeSelection } from '../data-model/types.js';

export interface FgaScanPromptContext {
  /** Phase-1 discovery, already narrowed to the user's selected scope */
  dataModel: DataModelDiscovery;
  /** How the user scoped the scan, so the summary is framed as that subset
   *  (a single domain) rather than the whole application. */
  scope?: ScopeSelection;
}

/** Human phrase for the chosen scope, or null for a whole-app scan. */
function describeScope(scope?: ScopeSelection): string | null {
  if (scope?.mode === 'domains' && scope.domains?.length) {
    const names = scope.domains.map((d) => `'${d}'`).join(', ');
    return `the ${names} domain${scope.domains.length > 1 ? 's' : ''}`;
  }
  if (scope?.mode === 'entities' && scope.entities?.length) {
    return `a selected subset of entities (${scope.entities.join(', ')})`;
  }
  return null;
}

const FGA_DOCS_URL = 'https://workos.com/docs/fga';

/**
 * Primer on WorkOS FGA concepts injected into the prompt so the agent grounds
 * its proposal in the actual product model rather than generic ReBAC theory.
 */
const FGA_CONCEPTS = `## WorkOS FGA Concepts (source of truth)

WorkOS Fine-Grained Authorization (FGA) is a relationship-based authorization system built on
three primitives:

- **Subjects** — who gets access. In WorkOS this is almost always an **organization membership**.
  Do NOT model \`user\`/\`member\`/\`account-holder\` as a resource type; they are subjects.
- **Resources** — the business entities access is granted on (workspaces, projects, repos,
  dashboards). Resources are arranged in a HIERARCHY and permissions flow DOWN from parent to
  child automatically. \`organization\` is the implicit root of every hierarchy.
- **Privileges (roles & permissions)** — scoped to a specific resource type (not tenant-wide).
  A role is a named bundle of permissions; a permission is a single capability like
  \`project:edit\`. Permissions use \`resource_type:action\` naming, lowercase.
- **Assignments** — bind an organization membership (subject) to a role on a particular resource
  instance.

The defining feature is **hierarchical inheritance**: a role assigned on a parent resource
automatically grants its child-type permissions on every descendant. An admin on a workspace gets
admin on every project and app nested under it — no per-child assignments needed. There is **no
explicit traversal syntax** (no \`viewer from parent\`) — you express inheritance by INCLUDING
child-type permissions in a parent-scoped role. This is the main difference from tenant-wide RBAC,
where roles apply to the whole organization.

### Hard constraints you MUST respect

- Max hierarchy depth: **5 levels**.
- Parents per resource **instance**: exactly **1** (each instance has one parent at runtime).
- Parent **types** a resource type may accept: multiple allowed.
- Child types per resource type: up to **10**.
- Resource types per environment: ~50 (soft). Resource instances **per type per org**: ~5,000
  soft — raisable on request if needed. This is a per-type, per-org limit, so an entity with
  thousands of rows per org is usually fine to model; it's only a concern when a single org would
  hold many times that of one type.

A proposal that violates depth, single-parent, or the cardinality guidance is wrong — revise it
before emitting.

Docs: ${FGA_DOCS_URL}`;

/**
 * Modeling methodology distilled from the WorkOS "model your app" playbook.
 * Phase-1 discovery + scoping already happened upstream, so this focuses on how
 * to turn the SCOPED entities into a hierarchy, roles, and integration advice.
 */
const FGA_METHODOLOGY = `## Modeling methodology

### Choosing resource types
- **Include** tenant containers and shareable entities: organizations, workspaces, teams,
  projects, environments, repositories, pipelines, apps, dashboards, accounts, datasets.
- **Exclude** subjects (\`user\`/\`member\` → memberships) and pure user-bundling groups (model as
  direct role assignments for now — user groups are not yet first-class).
- **Model an entity as a resource type when it has its own access control** — even at higher
  volumes. The ~5,000-per-type-per-org soft limit (raisable on request if needed) is generous, so
  thousands of rows per org is fine. If an entity has per-instance sharing/ACLs (e.g. a document or
  file that can be shared with specific members independent of its parent), model it. Only keep an
  entity in the **database** (authorized through its nearest modeled ancestor, e.g. check
  \`project:view\` on the parent project) when EITHER it has no per-instance access differentiation
  — access is fully determined by its parent — OR a single org would realistically hold many times
  the soft limit of that type (think raw logs, events, audit records, per-keystroke rows). Don't
  reflexively exclude files/comments/tasks: judge by whether they carry their own access control
  and their realistic per-org volume.
- **Lean against self-nesting types** (folders, categories, org units). A self-referential
  hierarchy pushes real complexity into the app and hits the 5-level depth cap. Model one only
  when each level genuinely carries its own access control; otherwise authorize via the nearest
  modeled ancestor. Note the trade-off in \`warnings\`.

### Building the hierarchy
- Use owning foreign keys (the \`NOT NULL\` \`*_id\` that ties a child to its parent) and nested
  route prefixes to derive parent→child links. A many-to-many join (e.g. \`project_collaborators\`)
  is usually a **role assignment**, not a resource type.
- Keep it shallow (2–4 levels typical; 5 is the hard ceiling). Sanity-check against the shapes
  WorkOS documents: multi-tenant SaaS (\`organization → workspace → project → app/database\`),
  developer platform (\`organization → repository → branch/secret\`), analytics
  (\`organization → account → dashboard\`).

### Roles & permissions
- Permissions: \`{resource_type}:{action}\` — \`view\` (read/list/show), \`edit\` (update/settings),
  \`create\` (checked on the PARENT resource), \`delete\`, plus domain verbs you find in the code
  (\`app:deploy\`, \`project:invite\`, \`dashboard:export\`). Mirror the customer's own vocabulary.
- Roles: name them \`{resource-type}-{capability}\` (e.g. \`workspace-admin\`, \`project-editor\`).
  Each role is scoped to one resource type but may include permissions from that type AND its
  child types — that inclusion is how inheritance is expressed (set \`cascades: true\` when a role
  carries child-type permissions).
- Build a capability ladder, widening downward: a **viewer/member** (read on the type + children),
  an **editor/contributor** (viewer + edit/create), an **admin** (editor + delete/manage on the
  type and all descendants).

### Translating an existing authorization model
If the codebase already uses OpenFGA, Oso/Polar, SpiceDB/AuthZed, CASL, or hand-rolled roles, MAP
it rather than inventing one:
- \`type\`/\`definition\`/\`resource\` block → resource type; \`parent\` relation / owning FK →
  parent–child link; a named relation/role (\`viewer\`,\`editor\`,\`admin\`) → a role with a
  permission set; \`or\`/union of relations → multiple permissions in one role.
- \`viewer from parent\` / \`->\` / \`role if role on relation\` → native inheritance (put the child
  permission in the parent's role — no traversal syntax).
- \`and\`/intersection, \`but not\`/exclusion, contextual tuples/caveats/custom rules → these do
  NOT map cleanly. Flag them in \`warnings\` as "enforce in application code" rather than dropping
  them silently.

### Endpoint integration (capture as recommendations)
Note how the app should ENFORCE the model in \`recommendations\` (prose only — generating the
actual SDK code is a separate, opt-in follow-up step, not part of this pass):
- Detail / mutation endpoints → \`check()\`; default to **404 (not 403)** on an unauthorized read
  so resource existence doesn't leak across orgs (403 is fine for create/list on a visible parent).
- Create endpoints → \`check()\` the \`{child}:create\` permission on the **parent** resource.
- List views → \`listResourcesForMembership()\`, then hydrate from the DB.
- Detail views driving UI affordances → \`listEffectivePermissions()\` (one round trip).
- Mirror modeled entities into FGA on create (\`createResource()\`) and grant access with
  \`assignRole()\`. Resource types, permissions, and roles are configured in the **Dashboard** (not
  via API); resources and assignments are managed via API at runtime.

## Principles
- **Read-only.** Never write to the repo or the customer's FGA environment.
- **Evidence over invention.** Every resource type, role, and permission traces to scoped code.
- **Shallow and incremental.** Recommend the smallest model that captures real access
  differentiation; tell the customer to evolve it, not predict every future type.
- **Subjects are memberships, not resources.** Never model \`user\` as a resource type.
- **Inheritance, not traversal.** Express parent→child access by including child permissions in
  parent roles.
- **Model entities that carry their own access control**, even at thousands of rows per org (the
  per-type-per-org soft limit is ~5,000 and can be raised if needed). Keep an entity in the
  database only when its access is fully determined by its parent, or its per-org volume would run
  to many times the soft limit.
- **Mirror the customer's vocabulary** in slugs and role names wherever possible.`;

export function buildFgaScanPrompt(context: FgaScanPromptContext): string {
  const { dataModel } = context;
  const scopeLabel = describeScope(context.scope);

  const scopeBlock = scopeLabel
    ? `\n## Analysis Scope\nThis analysis is scoped to **${scopeLabel}** of a larger application — the data model below is only that subset (plus any ancestor resource types up to the organization, included for hierarchy context). Model and describe ONLY this scope; do NOT present the proposal, or the summary, as if it covers the whole application.\n`
    : '';

  const summaryInstruction = `One paragraph: the shape of the proposed FGA model for ${
    scopeLabel ?? 'this application'
  } and why it fits this data model.${
    scopeLabel ? ` Frame the summary explicitly as ${scopeLabel}, NOT the whole application.` : ''
  } ALWAYS state that the hierarchy is rooted at the organization, which is the tenant.`;

  return `You are a WorkOS FGA modeling analyst — read the codebase the way a WorkOS solutions engineer would during a "model your app" session. A discovery pass already inventoried this project's data model, and the user scoped the analysis to the entities below. Propose how to model THESE entities with WorkOS Fine-Grained Authorization. You never write to the customer's repo or their FGA environment — you only read code and produce a recommendation.
${scopeBlock}
${FGA_CONCEPTS}

${FGA_METHODOLOGY}

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
2. Decide which scoped entities should become FGA resource types and how they nest (apply the
   methodology and hard constraints above).
3. Propose roles scoped to those resource types, with permissions and cascade behavior, built
   from a viewer→editor→admin capability ladder.
4. Produce example access checks that demonstrate how cascading inheritance answers real
   authorization questions in this application.
5. Capture endpoint-integration guidance (404-vs-403, parent checks for create, list/effective
   permissions, resource sync) and migration notes (intersections, exclusions, caveats that must
   move to app code) as \`recommendations\`. Do NOT write SDK code here — that is a separate
   opt-in follow-up step.

Report progress with [STATUS] prefixed lines as you work (e.g. "[STATUS] Reading membership model").

## Output Format
End with your analysis as a JSON object wrapped in a markdown code block:
\`\`\`json
{
  "summary": "${summaryInstruction}",
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
- ALWAYS include a resource type \`organization\` as the root (\`parent: null\`) — it is the tenant
  that owns everything, and every WorkOS FGA hierarchy starts there. Every other resource type's
  parent chain MUST lead up to \`organization\` (directly or transitively); there is exactly one root.
- The scoped data model may include ANCESTOR entities above the user's chosen domain (the path from
  the organization down to the domain's types). Model those intermediate resource types too, for
  hierarchy context — the domain's types should connect up to \`organization\` through them, not float
  as their own roots.
- Every resourceType's mappedEntities MUST name entities from the scoped data model above
  (\`organization\` itself may have empty mappedEntities if no explicit tenant table was found).
- Every "parent" value MUST be the "type" of another resourceType in your proposal (or null).
- Respect the hard constraints: max depth 5, exactly one parent per resource instance, ≤10 child
  types per type. Subjects are memberships — never model \`user\`/\`member\` as a resource type.
- Express inheritance by including child-type permissions in parent roles — never reach for
  traversal syntax.
- Model higher-volume entities (files, documents, comments, tasks) as resource types when they
  carry their own per-instance access control — the per-type-per-org soft limit is ~5,000 and can
  be raised if needed, so thousands of rows per org is fine. Keep an entity in the database
  (authorized via its nearest modeled ancestor) only when its access is fully determined by its
  parent, or its per-org volume would run to many times the soft limit (raw logs, events, audit
  rows). Lean against self-nesting types.
- Do NOT model every entity as a resource type. Only entities that gate access belong in the
  hierarchy; aim for shallow trees (2–4 levels typical, 5 max).
- Do NOT invent entities, relationships, or existing authorization behavior you did not observe.
- If the scoped model has no plausible access-gating entities, return empty arrays and explain
  why in the summary — do not fabricate a proposal.
- Permissions use resource_type:action naming.
- You have read-only access (Read, Glob, Grep). Do not attempt to modify files or run commands.`;
}

/**
 * Phase-3 (opt-in) prompt: generate concrete SDK integration code for an
 * ALREADY-proposed FGA model. Kept out of the core analysis pass so the model
 * (resource types, roles, permissions) comes back fast; this only runs when the
 * user asks for code.
 */
export function buildIntegrationSnippetsPrompt(context: {
  dataModel: DataModelDiscovery;
  proposal: unknown;
}): string {
  const { dataModel, proposal } = context;

  return `You are a WorkOS FGA integration engineer. An FGA model has ALREADY been proposed for this project (below). Produce concrete, copyable SDK code that wires that model into the app's real routes and write paths. Read the app's route/controller files (Read/Glob/Grep) to ground the code in real endpoints and primary keys. You are read-only — never modify files.

## Proposed FGA model
${JSON.stringify(proposal, null, 2)}

## Scoped data model (for entity/field/route context)
${JSON.stringify({ source: dataModel.source, entities: dataModel.entities }, null, 2)}

## What to produce
Adapt the reference calls below to the app's real entity/route names, its language, and its
primary keys (the app's DB id is the FGA \`externalId\`). Cover the patterns that actually apply to
this app: detail/mutation checks, create-on-parent, list views, effective-permissions for UI,
reusable middleware, resource sync on create, and role assignment. Pair each snippet with a short
\`appliesTo\` (the route or write path it wires up).

Reference SDK calls (adapt — do not copy verbatim):
\`\`\`javascript
// Detail / mutation route — 404 on deny so existence doesn't leak
const { authorized } = await workos.authorization.check({
  organizationMembershipId,
  permissionSlug: 'project:edit',
  resourceTypeSlug: 'project',
  resourceExternalId: projectId, // your DB primary key = FGA external_id
});
if (!authorized) return res.status(404).json({ error: 'Not found' });

// Create route — check {child}:create on the PARENT
await workos.authorization.check({ organizationMembershipId, permissionSlug: 'project:create',
  resourceTypeSlug: 'workspace', resourceExternalId: workspaceId });

// List route — ask which resources the membership can see, then hydrate from the DB
const { data } = await workos.authorization.listResourcesForMembership({
  organizationMembershipId, permissionSlug: 'project:view', resourceTypeSlug: 'project', limit: 50 });
const projects = await db.projects.findMany({ where: { id: { in: data.map((r) => r.externalId) } } });

// Reusable middleware
const requirePermission = ({ permissionSlug, resourceTypeSlug, paramName }) => async (req, res, next) => {
  const { authorized } = await workos.authorization.check({
    organizationMembershipId: req.user.organizationMembershipId,
    permissionSlug, resourceTypeSlug, resourceExternalId: req.params[paramName] });
  return authorized ? next() : res.status(404).json({ error: 'Not found' });
};

// Resource sync — mirror into FGA in the same path that creates the row
const project = await db.projects.create({ name, workspaceId });
await workos.authorization.createResource({ organizationId, resourceTypeSlug: 'project',
  externalId: project.id, name: project.name,
  parentResourceTypeSlug: 'workspace', parentResourceExternalId: workspaceId });

// Grant access
await workos.authorization.assignRole({ organizationMembershipId, roleSlug: 'workspace-admin',
  resourceTypeSlug: 'workspace', resourceExternalId: workspaceId });
\`\`\`

Report progress with [STATUS] prefixed lines (e.g. "[STATUS] Reading project routes").

## Output Format
End with ONLY this JSON object wrapped in a markdown code block:
\`\`\`json
{
  "integrationSnippets": [
    {
      "title": "Authorize a project detail route",
      "language": "javascript",
      "appliesTo": "GET /projects/:id",
      "code": "const { authorized } = await workos.authorization.check({ ... });\\nif (!authorized) return res.status(404).json({ error: 'Not found' });"
    }
  ]
}
\`\`\`

## Rules
- Snippets MUST use the proposed resource types / permission slugs above and the WorkOS
  authorization methods shown — tailored to entities/routes you actually observed.
- Return an empty array if you found no protected routes or write paths to wire up; never invent
  endpoints.
- You have read-only access (Read, Glob, Grep). Do not attempt to modify files or run commands.`;
}
