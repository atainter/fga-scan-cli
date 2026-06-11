import type { DataModelDiscovery, ScopeSelection } from '../data-model/types.js';

export interface FgaResourceTypeProposal {
  /** Identifier-style resource type, e.g. `organization`, `project` */
  type: string;
  displayName: string;
  /** Parent resource type in the proposed hierarchy, null for roots */
  parent: string | null;
  /** Entities from the customer's data model this resource type maps to */
  mappedEntities: string[];
  rationale: string;
}

export interface FgaRoleProposal {
  name: string;
  /** Resource type this role is scoped to */
  resourceType: string;
  permissions: string[];
  /** Whether the role's permissions cascade to descendant resources */
  cascades: boolean;
  rationale?: string;
}

export interface FgaExampleCheck {
  description: string;
  subject: string;
  permission: string;
  resource: string;
  expected: boolean;
  /** Explanation of the inheritance path that produces the result */
  path?: string;
}

export interface FgaRecommendation {
  title: string;
  detail: string;
  priority: 'high' | 'medium' | 'low';
}

/**
 * Structured output of the phase-2 analysis agent. The data model itself is
 * NOT part of the analysis — phase 1 (discovery + scoping) owns it.
 */
export interface FgaAnalysis {
  summary: string;
  proposal: {
    resourceTypes: FgaResourceTypeProposal[];
    roles: FgaRoleProposal[];
    exampleChecks: FgaExampleCheck[];
  };
  recommendations: FgaRecommendation[];
  warnings: string[];
}

export interface DataModelSourceHint {
  /** e.g. 'prisma', 'drizzle', 'typeorm', 'sql-migrations', 'rails', 'django' */
  kind: string;
  files: string[];
}

export interface DataModelHints {
  sources: DataModelSourceHint[];
}

export interface FgaScanReport {
  version: string;
  timestamp: string;
  target: 'fga';
  project: {
    path: string;
    language: string | null;
    framework: string | null;
  };
  dataModelHints: DataModelHints;
  /** Phase-1 result, narrowed to the user's scope. Null when discovery failed. */
  dataModel: DataModelDiscovery | null;
  /** How the user scoped the scan (whole app, domains, or entities) */
  scope: ScopeSelection;
  /** Names from --domains/--entities flags that didn't match the discovery */
  scopeWarnings?: string[];
  /** Phase-2 result. Null when the analysis was skipped or unparseable. */
  analysis: FgaAnalysis | null;
  model: string;
  durationMs: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface FgaScanOptions {
  installDir: string;
  json?: boolean;
  /** Serve the HTML report and open the browser (human mode only) */
  open?: boolean;
  /** Write the HTML report to this path */
  out?: string;
  /** Comma-separated domain names to scope the scan to (skips the picker) */
  domains?: string;
  /** Comma-separated entity names to scope the scan to (skips the picker) */
  entities?: string;
  /** Bypass the LLM gateway and use ANTHROPIC_API_KEY directly */
  direct?: boolean;
  debug?: boolean;
  /** Status callback for progress rendering (spinner etc.) */
  onStatus?: (message: string) => void;
  /**
   * Interactive scoping hook, called between discovery and analysis when no
   * --domains/--entities flags are set. Omit for headless runs (scope: all).
   * Implementations should exit the process themselves on user cancel.
   */
  selectScope?: (discovery: DataModelDiscovery) => Promise<ScopeSelection>;
}
