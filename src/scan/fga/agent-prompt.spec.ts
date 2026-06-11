import { describe, it, expect } from 'vitest';
import { buildFgaScanPrompt, buildIntegrationSnippetsPrompt } from './agent-prompt.js';
import type { DataModelDiscovery } from '../data-model/types.js';

const dataModel: DataModelDiscovery = {
  source: 'prisma',
  summary: 'A multi-tenant app.',
  entities: [{ name: 'Project', filePath: 'prisma/schema.prisma', relationships: [] }],
  domains: [{ name: 'Projects', entities: ['Project'] }],
};

describe('buildFgaScanPrompt (core analysis)', () => {
  it('asks for the model but NOT integration code', () => {
    const prompt = buildFgaScanPrompt({ dataModel });

    expect(prompt).toContain('"resourceTypes"');
    expect(prompt).toContain('"recommendations"');
    // Code generation moved to the opt-in follow-up — keep the core pass lean.
    expect(prompt).not.toContain('"integrationSnippets"');
    expect(prompt).not.toContain('workos.authorization.check(');
  });

  it('frames the summary as the whole app when scope is all (or absent)', () => {
    const prompt = buildFgaScanPrompt({ dataModel, scope: { mode: 'all' } });
    expect(prompt).not.toContain('## Analysis Scope');
    expect(prompt).toContain('the shape of the proposed FGA model for this application');
  });

  it('scopes the summary to the selected domain', () => {
    const prompt = buildFgaScanPrompt({ dataModel, scope: { mode: 'domains', domains: ['Billing'] } });

    expect(prompt).toContain('## Analysis Scope');
    expect(prompt).toContain("scoped to **the 'Billing' domain**");
    // Summary instruction must tell the agent to frame it as the domain, not the app.
    expect(prompt).toContain("Frame the summary explicitly as the 'Billing' domain, NOT the whole application");
  });
});

describe('buildIntegrationSnippetsPrompt (opt-in follow-up)', () => {
  it('carries the reference SDK code and asks only for integrationSnippets', () => {
    const prompt = buildIntegrationSnippetsPrompt({
      dataModel,
      proposal: { resourceTypes: [], roles: [], exampleChecks: [] },
    });

    expect(prompt).toContain('"integrationSnippets"');
    expect(prompt).toContain('workos.authorization.check(');
    expect(prompt).toContain('listResourcesForMembership');
    expect(prompt).toContain('read-only');
  });
});
