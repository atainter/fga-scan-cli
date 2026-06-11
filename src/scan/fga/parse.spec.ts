import { describe, it, expect } from 'vitest';
import { parseFgaAgentOutput } from './parse.js';

const validAnalysis = {
  summary: 'A multi-tenant project tracker.',
  dataModel: {
    source: 'prisma',
    entities: [
      {
        name: 'Organization',
        filePath: 'prisma/schema.prisma',
        description: 'Tenant boundary',
        relationships: [{ to: 'Project', kind: 'hasMany', via: 'organizationId' }],
      },
    ],
  },
  proposal: {
    resourceTypes: [
      {
        type: 'organization',
        displayName: 'Organization',
        parent: null,
        mappedEntities: ['Organization'],
        rationale: 'Tenant root',
      },
      {
        type: 'project',
        displayName: 'Project',
        parent: 'organization',
        mappedEntities: ['Project'],
        rationale: 'Primary unit of collaboration',
      },
    ],
    roles: [
      {
        name: 'admin',
        resourceType: 'organization',
        permissions: ['project:create', 'project:delete'],
        cascades: true,
      },
    ],
    exampleChecks: [
      {
        description: 'Org admin edits a project',
        subject: 'user:alice',
        permission: 'project:edit',
        resource: 'project:atlas',
        expected: true,
        path: 'admin on organization:acme cascades down',
      },
    ],
  },
  recommendations: [{ title: 'Start shallow', detail: 'Two levels is enough.', priority: 'high' }],
  warnings: [],
};

describe('parseFgaAgentOutput', () => {
  it('parses a fenced JSON block', () => {
    const text = `[STATUS] Done exploring\n\n\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\``;
    const analysis = parseFgaAgentOutput(text);

    expect(analysis).not.toBeNull();
    expect(analysis!.summary).toBe('A multi-tenant project tracker.');
    expect(analysis!.proposal.resourceTypes).toHaveLength(2);
    expect(analysis!.proposal.resourceTypes[1].parent).toBe('organization');
    expect(analysis!.proposal.roles[0].cascades).toBe(true);
    expect(analysis!.recommendations[0].priority).toBe('high');
  });

  it('uses the LAST fenced block when progress text contains earlier blocks', () => {
    const text = `Here is a snippet:\n\`\`\`\nmodel Organization {}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\``;
    const analysis = parseFgaAgentOutput(text);

    expect(analysis).not.toBeNull();
    expect(analysis!.proposal.resourceTypes).toHaveLength(2);
  });

  it('parses bare JSON without a code fence', () => {
    const analysis = parseFgaAgentOutput(JSON.stringify(validAnalysis));

    expect(analysis).not.toBeNull();
    expect(analysis!.dataModel.source).toBe('prisma');
  });

  it('returns null for unparseable output', () => {
    expect(parseFgaAgentOutput('I could not analyze this project, sorry.')).toBeNull();
  });

  it('nulls out dangling parents and records a warning', () => {
    const broken = structuredClone(validAnalysis);
    broken.proposal.resourceTypes[1].parent = 'workspace'; // not a proposed type
    const analysis = parseFgaAgentOutput(`\`\`\`json\n${JSON.stringify(broken)}\n\`\`\``);

    expect(analysis!.proposal.resourceTypes[1].parent).toBeNull();
    expect(analysis!.warnings.some((w) => w.includes('unknown parent'))).toBe(true);
  });

  it('drops invalid entries instead of failing the parse', () => {
    const messy = structuredClone(validAnalysis) as Record<string, any>;
    messy.proposal.resourceTypes.push({ rationale: 'missing type field' });
    messy.proposal.roles.push({ name: 'orphan' }); // missing resourceType
    messy.recommendations.push('not an object');
    const analysis = parseFgaAgentOutput(`\`\`\`json\n${JSON.stringify(messy)}\n\`\`\``);

    expect(analysis!.proposal.resourceTypes).toHaveLength(2);
    expect(analysis!.proposal.roles).toHaveLength(1);
    expect(analysis!.recommendations).toHaveLength(1);
  });

  it('defaults invalid priority to medium', () => {
    const messy = structuredClone(validAnalysis) as Record<string, any>;
    messy.recommendations[0].priority = 'urgent';
    const analysis = parseFgaAgentOutput(`\`\`\`json\n${JSON.stringify(messy)}\n\`\`\``);

    expect(analysis!.recommendations[0].priority).toBe('medium');
  });
});
