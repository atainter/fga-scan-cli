import { describe, it, expect } from 'vitest';
import { generateFgaReportHtml, buildHierarchyMermaid, escapeHtml } from './html-report.js';
import type { FgaScanReport } from './types.js';

function report(overrides?: Partial<FgaScanReport>): FgaScanReport {
  return {
    version: '1.0.0',
    timestamp: '2026-01-01T00:00:00.000Z',
    target: 'fga',
    project: { path: '/tmp/app', language: 'JavaScript/TypeScript', framework: 'Next.js' },
    dataModelHints: { sources: [{ kind: 'prisma', files: ['prisma/schema.prisma'] }] },
    analysis: {
      summary: 'A multi-tenant tracker.',
      dataModel: {
        source: 'prisma',
        entities: [{ name: 'Organization', filePath: 'prisma/schema.prisma', relationships: [] }],
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
            rationale: 'Unit of collaboration',
          },
        ],
        roles: [
          { name: 'admin', resourceType: 'organization', permissions: ['project:create'], cascades: true },
        ],
        exampleChecks: [
          {
            description: 'Org admin edits project',
            subject: 'user:alice',
            permission: 'project:edit',
            resource: 'project:atlas',
            expected: true,
          },
        ],
      },
      recommendations: [{ title: 'Keep it shallow', detail: 'Two levels.', priority: 'high' }],
      warnings: ['Membership table is ambiguous'],
    },
    model: 'claude-test',
    durationMs: 1234,
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;',
    );
  });
});

describe('buildHierarchyMermaid', () => {
  it('renders nodes with roles and parent edges', () => {
    const mermaid = buildHierarchyMermaid(report());

    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('organization --> project');
    expect(mermaid).toContain('<b>Organization</b>');
    expect(mermaid).toContain('admin');
  });

  it('sanitizes resource types into valid node ids', () => {
    const r = report();
    r.analysis!.proposal.resourceTypes[0].type = 'my org!';
    r.analysis!.proposal.resourceTypes[1].parent = 'my org!';
    const mermaid = buildHierarchyMermaid(r);

    expect(mermaid).toContain('my_org_ --> project');
  });

  it('returns empty string without an analysis', () => {
    expect(buildHierarchyMermaid(report({ analysis: null }))).toBe('');
  });
});

describe('generateFgaReportHtml', () => {
  it('includes all report sections', () => {
    const html = generateFgaReportHtml(report());

    expect(html).toContain('FGA Modeling Proposal');
    expect(html).toContain('A multi-tenant tracker.');
    expect(html).toContain('Proposed Resource Hierarchy');
    expect(html).toContain('Roles &amp; Permissions');
    expect(html).toContain('Example Access Checks');
    expect(html).toContain('Keep it shallow');
    expect(html).toContain('Membership table is ambiguous');
    expect(html).toContain('https://workos.com/docs/fga');
  });

  it('escapes attacker-controlled values from the scanned project', () => {
    const r = report();
    r.analysis!.summary = '<script>alert(1)</script>';
    const html = generateFgaReportHtml(r);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders an empty state when there is no analysis', () => {
    const html = generateFgaReportHtml(report({ analysis: null, skipped: true, skipReason: 'Nothing parseable' }));

    expect(html).toContain('Nothing parseable');
    expect(html).not.toContain('Proposed Resource Hierarchy');
  });
});
