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
- Resource types per environment: ~50 (soft). Resource instances per type per org: ~5,000 (soft).

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
- **Default high-cardinality leaf data to the database** — files, messages, comments, tasks, rows,
  logs, events, audit records. Authorize them through their nearest modeled ancestor (e.g. check
  \`project:view\` on the parent project, not the file). Only promote such an entity to a resource
  type when access is genuinely per-instance, that differentiation is a real product requirement
  (cite the sharing/ACL code), and instance counts stay within the ~5,000-per-type soft limit.
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

### Endpoint integration (emit as integrationSnippets)
For the app's protected routes and write paths, emit concrete, copyable SDK code in
\`integrationSnippets\` — adapt the reference calls below to the app's real entity/route names,
its language, and its primary keys (your DB id is the FGA \`externalId\`). Pair each snippet with a
short \`appliesTo\` (e.g. the route or write path). Guidance:
- Detail / mutation endpoints → \`workos.authorization.check()\`; default to returning **404 (not
  403)** on an unauthorized read so resource existence doesn't leak across orgs (403 is fine for
  create/list on a parent the user can already see).
- Create endpoints → \`check()\` the \`{child}:create\` permission on the **parent** resource.
- List views → \`listResourcesForMembership()\`, then hydrate from the DB.
- Detail views driving UI affordances → \`listEffectivePermissions()\` (one round trip).
- Mirror modeled entities into FGA on create (\`createResource()\` with the DB id as \`externalId\`
  and the parent link) and grant access with \`assignRole()\`. Resource types, permissions, and
  roles are configured in the **Dashboard** (not via API); resources and assignments are managed
  via API at runtime.

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

## Principles
- **Read-only.** Never write to the repo or the customer's FGA environment.
- **Evidence over invention.** Every resource type, role, and permission traces to scoped code.
- **Shallow and incremental.** Recommend the smallest model that captures real access
  differentiation; tell the customer to evolve it, not predict every future type.
- **Subjects are memberships, not resources.** Never model \`user\` as a resource type.
- **Inheritance, not traversal.** Express parent→child access by including child permissions in
  parent roles.
- **Default high-cardinality data to the database**, authorized via its nearest ancestor.
- **Mirror the customer's vocabulary** in slugs and role names wherever possible.`;

export function buildFgaScanPrompt(context: FgaScanPromptContext): string {
  const { dataModel } = context;

  return `You are a WorkOS FGA modeling analyst — read the codebase the way a WorkOS solutions engineer would during a "model your app" session. A discovery pass already inventoried this project's data model, and the user scoped the analysis to the entities below. Propose how to model THESE entities with WorkOS Fine-Grained Authorization. You never write to the customer's repo or their FGA environment — you only read code and produce a recommendation.

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
5. Emit concrete, copyable SDK code for wiring FGA into the app's real routes and write paths
   as \`integrationSnippets\` (adapt the reference calls to the app's entities, language, and
   primary keys). Capture migration guidance and anything that must move to app code
   (intersections, exclusions, caveats, 404-vs-403 policy) as \`recommendations\`.

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
  "integrationSnippets": [
    {
      "title": "Authorize a project detail route",
      "language": "javascript",
      "appliesTo": "GET /projects/:id",
      "code": "const { authorized } = await workos.authorization.check({ ... });\\nif (!authorized) return res.status(404).json({ error: 'Not found' });"
    }
  ],
  "warnings": ["Anything ambiguous or risky about the proposal"]
}
\`\`\`

## Rules
- Every resourceType's mappedEntities MUST name entities from the scoped data model above.
  No evidence — drop it.
- Every "parent" value MUST be the "type" of another resourceType in your proposal (or null).
- Respect the hard constraints: max depth 5, exactly one parent per resource instance, ≤10 child
  types per type. Subjects are memberships — never model \`user\`/\`member\` as a resource type.
- Express inheritance by including child-type permissions in parent roles — never reach for
  traversal syntax.
- Default high-cardinality leaf data (files, messages, comments, logs, rows) to the database,
  authorized via its nearest modeled ancestor; promote it to a resource type only with cited
  per-instance access-control evidence. Lean against self-nesting resource types.
- Do NOT model every entity as a resource type. Only entities that gate access belong in the
  hierarchy; aim for 2–4 levels.
- Do NOT invent entities, relationships, or existing authorization behavior you did not observe.
- If the scoped model has no plausible access-gating entities, return empty arrays and explain
  why in the summary — do not fabricate a proposal.
- Permissions use resource_type:action naming.
- integrationSnippets MUST be real, adaptable SDK code grounded in the WorkOS authorization
  methods above — tailored to entities/routes you actually observed. Omit the array if you found
  no protected routes or write paths to wire up; never invent endpoints.
- You have read-only access (Read, Glob, Grep). Do not attempt to modify files or run commands.`;
}
