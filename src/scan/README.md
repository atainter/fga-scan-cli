# `workos scan` — AI-powered project scans

First target: `workos scan fga`. The scan runs in **two phases with a hard boundary between
them**, so the phases can be developed and iterated on independently.

## Phase 1 — Data model discovery & scoping (`src/scan/data-model/`)

Inventory the customer's data model accurately, then let them narrow the scan to a domain.
Everything downstream depends on this model being right.

**Pick-a-domain-first**, so the expensive relationship-extraction + FGA reasoning only run on the
chosen domain (interactive, unflagged runs):

1. **Outline** (`buildDomainOutlinePrompt` / `discoverDomainOutline`) — a cheap pass that lists
   entities (names + file paths) grouped into domains, *no relationships*. Fills the picker.
2. **Pick** (`promptForDomain`) — the user chooses a single domain (or the whole app).
3. **Focused deep discovery** (`buildDiscoveryPrompt` with `focusEntities` / `discoverDataModel`) —
   extracts relationships for the picked entities only.

Headless / `--domains` / `--entities` / `--json` runs skip the outline and do one full discovery,
then resolve scope from the flags (or analyze everything).

- `collectors.ts` (in `fga/`, moving here is fair game) — deterministic glob-based hints
  (Prisma, Drizzle, TypeORM, SQL migrations, Rails, Django, GraphQL, Mongoose)
- `discovery-prompt.ts` — outline prompt + relationship-extracting discovery prompt (with optional
  `focusEntities` to scope the deep pass to one domain)
- `parse.ts` — defensive parser; enforces file-path evidence and referential integrity (tolerates
  the outline's missing relationships)
- `scope.ts` — pure scope narrowing (`applyScope`) + `--domains`/`--entities` flag resolution
- `picker.ts` — `promptForDomain` (single domain or all, shown after the outline); `promptForScope`
  retained for entity-level selection
- `parsers/` — **deterministic schema parsers, tried before any AI discovery**: Prisma
  (`@mrleebo/prisma-ast`), Drizzle migration snapshots (plain JSON, no TS parsing), Rails
  `db/schema.rb` (structured line parser), DBML + MySQL DDL (`@dbml/core`, the dbdiagram.io
  engine), and Postgres DDL/migrations (`pgsql-ast-parser`, per-statement error recovery).
  All parsers target a shared `RawSchema` intermediate (`raw-schema.ts`); one converter derives
  relationships from FK constraints (FK → belongsTo, unique FK → hasOne, pure join table →
  manyToMany — tables with payload columns like membership `role` stay entities). When a parser
  succeeds, BOTH AI discovery passes are skipped: phase 1 is exact, instant, and free.
  `--ai-discovery` forces the agent route. Unsupported stacks (SQLAlchemy, Django, Sequelize,
  GORM, JPA…) fall back to AI discovery automatically.
- `artifact.ts` — load/save pre-existing model artifacts. `--model <path>` accepts a previous
  scan's saved JSON or a Mermaid `erDiagram` (bare `.mmd` or inside a markdown fence) and skips
  AI discovery entirely; after every AI discovery the CLI saves a reusable artifact to tmp and
  prints a `--model` hint. Mermaid imports synthesize domains from relationship-graph connected
  components. This is also the fixture mechanism for iterating on phase 2 without running phase 1.

**Trade-off:** picking one domain defers all heavy work to that domain; picking "all" adds one
cheap outline pass before the full deep discovery. Models are unchanged (Opus throughout).

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
