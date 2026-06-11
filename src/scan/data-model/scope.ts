import type { DataModelDiscovery, ScopeSelection } from './types.js';

/**
 * Narrow a discovery to the selected scope. Relationships pointing outside
 * the scope are dropped so downstream consumers (diagrams, FGA analysis)
 * never reference entities the user excluded.
 */
export function applyScope(discovery: DataModelDiscovery, selection: ScopeSelection): DataModelDiscovery {
  if (selection.mode === 'all') return discovery;

  let keep: Set<string>;
  if (selection.mode === 'domains') {
    const selected = new Set(selection.domains ?? []);
    keep = new Set(discovery.domains.filter((d) => selected.has(d.name)).flatMap((d) => d.entities));
  } else {
    keep = new Set(selection.entities ?? []);
  }

  const entities = discovery.entities
    .filter((e) => keep.has(e.name))
    .map((e) => ({
      ...e,
      relationships: e.relationships.filter((r) => keep.has(r.to)),
    }));

  const domains = discovery.domains
    .map((d) => ({ ...d, entities: d.entities.filter((name) => keep.has(name)) }))
    .filter((d) => d.entities.length > 0);

  return { ...discovery, entities, domains };
}

/**
 * Resolve scope from --domains / --entities flags. Returns null when neither
 * flag is set (caller decides between the interactive picker and 'all').
 * Unknown names are reported so a typo doesn't silently scan nothing.
 */
export function resolveScopeFromFlags(
  discovery: DataModelDiscovery,
  flags: { domains?: string; entities?: string },
): { selection: ScopeSelection; unknown: string[] } | null {
  if (flags.domains) {
    const requested = flags.domains.split(',').map((s) => s.trim()).filter(Boolean);
    const known = new Set(discovery.domains.map((d) => d.name));
    return {
      selection: { mode: 'domains', domains: requested.filter((d) => known.has(d)) },
      unknown: requested.filter((d) => !known.has(d)),
    };
  }
  if (flags.entities) {
    const requested = flags.entities.split(',').map((s) => s.trim()).filter(Boolean);
    const known = new Set(discovery.entities.map((e) => e.name));
    return {
      selection: { mode: 'entities', entities: requested.filter((e) => known.has(e)) },
      unknown: requested.filter((e) => !known.has(e)),
    };
  }
  return null;
}
