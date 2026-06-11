export interface FgaEntityRelationship {
  /** Target entity name */
  to: string;
  kind: 'belongsTo' | 'hasMany' | 'hasOne' | 'manyToMany';
  /** Join table / foreign key the relationship was inferred from */
  via?: string;
}

export interface FgaDetectedEntity {
  name: string;
  filePath?: string;
  description?: string;
  relationships: FgaEntityRelationship[];
}

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

/** Structured output produced by the scan agent */
export interface FgaAnalysis {
  summary: string;
  dataModel: {
    /** Primary schema source, e.g. 'prisma', 'drizzle', 'sql', 'rails' */
    source: string | null;
    entities: FgaDetectedEntity[];
  };
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
  /** Null when the agent output could not be parsed or the scan was skipped */
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
  /** Bypass the LLM gateway and use ANTHROPIC_API_KEY directly */
  direct?: boolean;
  debug?: boolean;
  /** Status callback for progress rendering (spinner etc.) */
  onStatus?: (message: string) => void;
}
