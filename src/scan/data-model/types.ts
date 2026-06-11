export interface EntityRelationship {
  /** Target entity name */
  to: string;
  kind: 'belongsTo' | 'hasMany' | 'hasOne' | 'manyToMany';
  /** Join table / foreign key the relationship was inferred from */
  via?: string;
}

export interface DiscoveredEntity {
  name: string;
  /** Where the entity is defined — required evidence, no file means no entity */
  filePath: string;
  description?: string;
  relationships: EntityRelationship[];
}

/**
 * A logical grouping of entities (e.g. "Billing", "Projects") suggested by
 * the discovery agent. Domains drive the interactive narrowing step.
 */
export interface DiscoveredDomain {
  name: string;
  description?: string;
  entities: string[];
}

/** Phase-1 output: the project's data model as discovered by the agent */
export interface DataModelDiscovery {
  /** Primary schema source, e.g. 'prisma', 'drizzle', 'sql', 'rails' */
  source: string | null;
  summary: string;
  entities: DiscoveredEntity[];
  domains: DiscoveredDomain[];
}

export interface ScopeSelection {
  mode: 'all' | 'domains' | 'entities';
  /** Domain names, when mode === 'domains' */
  domains?: string[];
  /** Entity names, when mode === 'entities' */
  entities?: string[];
}
