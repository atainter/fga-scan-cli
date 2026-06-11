import clack from '../../utils/clack.js';
import type { DataModelDiscovery, ScopeSelection } from './types.js';

/**
 * "Pick a domain first" scoping: shown after the cheap outline pass and BEFORE
 * the expensive deep discovery + FGA reasoning. The user picks a single domain
 * (or the whole app); the choice scopes both the deep pass and the analysis.
 * Returns null when the user cancels (Ctrl+C) — callers exit with CANCELLED.
 */
export async function promptForDomain(outline: DataModelDiscovery): Promise<ScopeSelection | null> {
  const entityCount = outline.entities.length;

  const choice = await clack.select({
    message: `Found ${entityCount} entities across ${outline.domains.length} domains. Which domain should the FGA analysis cover?`,
    options: [
      { value: '__all__', label: 'The whole application', hint: `${entityCount} entities` },
      ...outline.domains.map((d) => ({
        value: d.name,
        label: d.name,
        hint: `${d.entities.length} entities${d.description ? ` — ${d.description}` : ''}`,
      })),
    ],
  });
  if (clack.isCancel(choice)) return null;

  return choice === '__all__' ? { mode: 'all' } : { mode: 'domains', domains: [choice as string] };
}

/**
 * Interactive scoping: after discovery, let the user narrow the scan to a
 * domain or a hand-picked set of entities. Returns null when the user
 * cancels (Ctrl+C) — callers should exit with the cancelled code.
 */
export async function promptForScope(discovery: DataModelDiscovery): Promise<ScopeSelection | null> {
  const entityCount = discovery.entities.length;
  const domainCount = discovery.domains.length;

  const choice = await clack.select({
    message: `Found ${entityCount} entities across ${domainCount} domains. What should the FGA analysis cover?`,
    options: [
      { value: 'all', label: 'The whole application', hint: `${entityCount} entities` },
      ...(domainCount > 1
        ? [{ value: 'domains', label: 'Narrow to specific domains', hint: discovery.domains.map((d) => d.name).join(', ') }]
        : []),
      { value: 'entities', label: 'Pick individual entities' },
    ],
  });
  if (clack.isCancel(choice)) return null;

  if (choice === 'all') {
    return { mode: 'all' };
  }

  if (choice === 'domains') {
    const domains = await clack.multiselect({
      message: 'Select the domains to analyze',
      options: discovery.domains.map((d) => ({
        value: d.name,
        label: d.name,
        hint: `${d.entities.length} entities${d.description ? ` — ${d.description}` : ''}`,
      })),
      required: true,
    });
    if (clack.isCancel(domains)) return null;
    return { mode: 'domains', domains: domains as string[] };
  }

  const entities = await clack.multiselect({
    message: 'Select the entities to analyze',
    options: discovery.entities.map((e) => ({
      value: e.name,
      label: e.name,
      hint: e.filePath,
    })),
    required: true,
  });
  if (clack.isCancel(entities)) return null;
  return { mode: 'entities', entities: entities as string[] };
}
