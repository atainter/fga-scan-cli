# `workos scan` — AI-powered project scans

First target: `workos scan fga`. The scan runs in **two phases with a hard boundary between
them**, so the phases can be developed and iterated on independently.

## Phase 1 — Data model discovery & scoping (`src/scan/data-model/`)

Inventory the customer's data model accurately, then let them narrow the scan to a domain.
Everything downstream depends on this model being right.

- `collectors.ts` (in `fga/`, moving here is fair game) — deterministic glob-based hints
  (Prisma, Drizzle, TypeORM, SQL migrations, Rails, Django, GraphQL, Mongoose)
- `discovery-prompt.ts` — read-only agent prompt: entities + relationships + suggested domains
- `parse.ts` — defensive parser; enforces file-path evidence and referential integrity
- `scope.ts` — pure scope narrowing (`applyScope`) + `--domains`/`--entities` flag resolution
- `picker.ts` — interactive clack picker shown between the phases (whole app / domains / entities)

**Output contract:** `DataModelDiscovery` in `types.ts` — this is the interface phase 2 consumes.

## Phase 2 — FGA suggestion engine (`src/scan/fga/`)

Consumes the *scoped* `DataModelDiscovery` and proposes a WorkOS FGA model: resource-type
hierarchy, roles with cascading permissions, example access checks, recommendations.

- `agent-prompt.ts` — FGA concepts primer + scoped model + strict JSON output contract
- `parse.ts` — normalizes the proposal (dangling hierarchy parents become roots, etc.)
- `output.ts` / `json-output.ts` — terminal + JSON renderers
- `html-report.ts` — self-contained HTML report: Mermaid ER diagram of the scoped model and
  the proposed hierarchy diagram, in the style of https://workos.com/docs/fga
- `report-server.ts` — ephemeral in-memory Hono server, auto-opened in the browser

## Shared plumbing (`src/scan/`)

- `agent.ts` — read-only agent runner (Read/Glob/Grep only) reusing the installer's gateway
  auth / credential proxy / `--direct` mode
- `json-extract.ts` — fenced-JSON extraction shared by both parsers

## Orchestration

`src/scan/fga/index.ts#runFgaScan` sequences: detect → discover → scope (flags > picker > all)
→ analyze → report. The command handler (`src/commands/scan.ts`) owns all interactivity; the
orchestrator stays UI-free apart from the injected `selectScope` hook.
