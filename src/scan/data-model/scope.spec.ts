import { describe, it, expect } from 'vitest';
import { applyScope, resolveScopeFromFlags } from './scope.js';
import type { DataModelDiscovery } from './types.js';

function discovery(): DataModelDiscovery {
  return {
    source: 'prisma',
    summary: 'Tracker.',
    entities: [
      {
        name: 'Organization',
        filePath: 'prisma/schema.prisma',
        relationships: [{ to: 'Project', kind: 'hasMany' }],
      },
      {
        name: 'Project',
        filePath: 'prisma/schema.prisma',
        relationships: [
          { to: 'Organization', kind: 'belongsTo' },
          { to: 'Invoice', kind: 'hasMany' },
        ],
      },
      { name: 'Invoice', filePath: 'prisma/schema.prisma', relationships: [] },
    ],
    domains: [
      { name: 'Projects', entities: ['Organization', 'Project'] },
      { name: 'Billing', entities: ['Invoice'] },
    ],
  };
}

describe('applyScope', () => {
  it('returns the discovery untouched for mode all', () => {
    const d = discovery();
    expect(applyScope(d, { mode: 'all' })).toBe(d);
  });

  it('narrows to selected domains and drops out-of-scope relationships', () => {
    const scoped = applyScope(discovery(), { mode: 'domains', domains: ['Projects'] });

    expect(scoped.entities.map((e) => e.name)).toEqual(['Organization', 'Project']);
    // Project → Invoice relationship dropped because Invoice is out of scope
    expect(scoped.entities[1].relationships.map((r) => r.to)).toEqual(['Organization']);
    expect(scoped.domains.map((d) => d.name)).toEqual(['Projects']);
  });

  it('narrows to selected entities', () => {
    const scoped = applyScope(discovery(), { mode: 'entities', entities: ['Invoice'] });

    expect(scoped.entities.map((e) => e.name)).toEqual(['Invoice']);
    expect(scoped.domains.map((d) => d.name)).toEqual(['Billing']);
  });
});

describe('resolveScopeFromFlags', () => {
  it('returns null when neither flag is set', () => {
    expect(resolveScopeFromFlags(discovery(), {})).toBeNull();
  });

  it('resolves domains and reports unknown names', () => {
    const result = resolveScopeFromFlags(discovery(), { domains: 'Projects, Bogus' });

    expect(result!.selection).toEqual({ mode: 'domains', domains: ['Projects'] });
    expect(result!.unknown).toEqual(['Bogus']);
  });

  it('resolves entities', () => {
    const result = resolveScopeFromFlags(discovery(), { entities: 'Project,Invoice' });

    expect(result!.selection).toEqual({ mode: 'entities', entities: ['Project', 'Invoice'] });
    expect(result!.unknown).toEqual([]);
  });
});
