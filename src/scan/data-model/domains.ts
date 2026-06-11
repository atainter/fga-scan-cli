import type { DiscoveredDomain } from './types.js';

export interface DomainEdge {
  from: string;
  to: string;
}

/**
 * Synthesize picker domains from the connected components of a relationship
 * graph, each named after its most-connected ("hub") entity. Singleton
 * components are left out — `normalizeDiscovery`'s "Other" catch-all picks
 * them up. Used wherever a model arrives without domain groupings
 * (Mermaid ERD imports, deterministic schema parsers).
 */
export function synthesizeDomains(entityNames: string[], edges: DomainEdge[]): DiscoveredDomain[] {
  const adjacency = new Map<string, Set<string>>();
  for (const name of entityNames) adjacency.set(name, new Set());
  for (const edge of edges) {
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }

  const visited = new Set<string>();
  const domains: DiscoveredDomain[] = [];
  for (const name of [...entityNames].sort()) {
    if (visited.has(name)) continue;
    const component: string[] = [];
    const queue = [name];
    visited.add(name);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    if (component.length < 2) continue;
    const hub = component.reduce((best, c) =>
      (adjacency.get(c)?.size ?? 0) > (adjacency.get(best)?.size ?? 0) ? c : best,
    );
    domains.push({
      name: hub,
      description: `Entities connected to ${hub}`,
      entities: component.sort(),
    });
  }
  return domains;
}
