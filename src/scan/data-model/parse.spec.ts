import { describe, it, expect } from 'vitest';
import { parseDiscoveryOutput } from './parse.js';

const validDiscovery = {
  source: 'prisma',
  summary: 'Multi-tenant project tracker.',
  entities: [
    {
      name: 'Organization',
      filePath: 'prisma/schema.prisma',
      description: 'Tenant boundary',
      relationships: [{ to: 'Project', kind: 'hasMany', via: 'organizationId' }],
    },
    {
      name: 'Project',
      filePath: 'prisma/schema.prisma',
      relationships: [{ to: 'Organization', kind: 'belongsTo', via: 'organizationId' }],
    },
    {
      name: 'Invoice',
      filePath: 'prisma/schema.prisma',
      relationships: [],
    },
  ],
  domains: [{ name: 'Projects', description: 'Tracking', entities: ['Organization', 'Project'] }],
};

describe('parseDiscoveryOutput', () => {
  it('parses a fenced discovery block', () => {
    const discovery = parseDiscoveryOutput(`\`\`\`json\n${JSON.stringify(validDiscovery)}\n\`\`\``);

    expect(discovery).not.toBeNull();
    expect(discovery!.source).toBe('prisma');
    expect(discovery!.entities).toHaveLength(3);
    expect(discovery!.entities[0].relationships[0]).toEqual({ to: 'Project', kind: 'hasMany', via: 'organizationId' });
  });

  it('drops entities without filePath evidence', () => {
    const messy = structuredClone(validDiscovery) as Record<string, any>;
    messy.entities.push({ name: 'Phantom', relationships: [] });
    const discovery = parseDiscoveryOutput(`\`\`\`json\n${JSON.stringify(messy)}\n\`\`\``);

    expect(discovery!.entities.map((e) => e.name)).not.toContain('Phantom');
  });

  it('drops relationships and domain members that reference unknown entities', () => {
    const messy = structuredClone(validDiscovery) as Record<string, any>;
    messy.entities[0].relationships.push({ to: 'Ghost', kind: 'hasMany' });
    messy.domains[0].entities.push('Ghost');
    const discovery = parseDiscoveryOutput(`\`\`\`json\n${JSON.stringify(messy)}\n\`\`\``);

    expect(discovery!.entities[0].relationships.map((r) => r.to)).not.toContain('Ghost');
    expect(discovery!.domains.flatMap((d) => d.entities)).not.toContain('Ghost');
  });

  it('collects ungrouped entities into an Other domain so the picker covers everything', () => {
    const discovery = parseDiscoveryOutput(`\`\`\`json\n${JSON.stringify(validDiscovery)}\n\`\`\``);

    const other = discovery!.domains.find((d) => d.name === 'Other');
    expect(other).toBeDefined();
    expect(other!.entities).toEqual(['Invoice']);
  });

  it('returns null for unparseable output', () => {
    expect(parseDiscoveryOutput('no json here')).toBeNull();
  });
});
