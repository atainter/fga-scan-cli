import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataModelDiscovery } from '../data-model/types.js';
import type { FgaAnalysis } from './types.js';

const mockDiscoverDomainOutline = vi.fn();
const mockDiscoverDataModel = vi.fn();
const mockRunScanAgent = vi.fn();
const mockParseFgaAgentOutput = vi.fn();
const mockParseIntegrationSnippets = vi.fn();

vi.mock('../../doctor/checks/language.js', () => ({ checkLanguage: () => ({ name: 'JavaScript/TypeScript' }) }));
vi.mock('../../doctor/checks/framework.js', () => ({ checkFramework: () => ({ name: 'Next.js', version: '14' }) }));
vi.mock('./collectors.js', () => ({ collectDataModelHints: () => ({ sources: [] }) }));
vi.mock('../data-model/discover.js', () => ({
  discoverDomainOutline: (...args: unknown[]) => mockDiscoverDomainOutline(...args),
  discoverDataModel: (...args: unknown[]) => mockDiscoverDataModel(...args),
}));
const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01, numTurns: 1 };
const emptyUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, numTurns: 0 };

vi.mock('../agent.js', () => ({
  runScanAgent: (...args: unknown[]) => mockRunScanAgent(...args),
  sumScanUsage: (list: (typeof usage)[]) =>
    list.reduce(
      (a, u) => ({
        inputTokens: a.inputTokens + u.inputTokens,
        outputTokens: a.outputTokens + u.outputTokens,
        cacheReadTokens: a.cacheReadTokens + u.cacheReadTokens,
        cacheCreationTokens: a.cacheCreationTokens + u.cacheCreationTokens,
        costUsd: a.costUsd + u.costUsd,
        numTurns: a.numTurns + u.numTurns,
      }),
      { ...emptyUsage },
    ),
}));
vi.mock('./parse.js', () => ({
  parseFgaAgentOutput: (...args: unknown[]) => mockParseFgaAgentOutput(...args),
  parseIntegrationSnippets: (...args: unknown[]) => mockParseIntegrationSnippets(...args),
}));

import { runFgaScan, generateIntegrationSnippets } from './index.js';

const outline: DataModelDiscovery = {
  source: 'prisma',
  summary: 'Outline.',
  entities: [
    { name: 'Project', filePath: 'prisma/schema.prisma', relationships: [] },
    { name: 'Invoice', filePath: 'prisma/schema.prisma', relationships: [] },
  ],
  domains: [
    { name: 'Projects', entities: ['Project'] },
    { name: 'Billing', entities: ['Invoice'] },
  ],
};

// A "full" model with relationships, as the unfocused deep pass would return.
const fullModel: DataModelDiscovery = {
  source: 'prisma',
  summary: 'Full.',
  entities: [
    { name: 'Project', filePath: 'prisma/schema.prisma', relationships: [] },
    { name: 'Invoice', filePath: 'prisma/schema.prisma', relationships: [{ to: 'Project', kind: 'belongsTo' }] },
  ],
  domains: [
    { name: 'Projects', entities: ['Project'] },
    { name: 'Billing', entities: ['Invoice'] },
  ],
};

const analysis: FgaAnalysis = {
  summary: 'ok',
  proposal: { resourceTypes: [], roles: [], exampleChecks: [] },
  recommendations: [],
  integrationSnippets: [],
  warnings: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRunScanAgent.mockResolvedValue({ outputText: '```json\n{}\n```', model: 'reason-model', durationMs: 1, usage });
  mockParseFgaAgentOutput.mockReturnValue(analysis);
  mockParseIntegrationSnippets.mockReturnValue([]);
});

describe('runFgaScan — pick-a-domain-first ordering', () => {
  it('outlines, then deep-discovers ONLY the picked domain', async () => {
    mockDiscoverDomainOutline.mockResolvedValue({ discovery: outline, model: 'outline-model', durationMs: 1, usage });
    mockDiscoverDataModel.mockResolvedValue({
      discovery: {
        source: 'prisma',
        summary: 'Deep.',
        entities: [{ name: 'Invoice', filePath: 'prisma/schema.prisma', relationships: [] }],
        domains: [{ name: 'Billing', entities: ['Invoice'] }],
      },
      model: 'deep-model',
      durationMs: 1,
      usage,
    });

    const onPhase = vi.fn();
    const report = await runFgaScan({
      installDir: '/tmp/app',
      selectScope: async () => ({ mode: 'domains', domains: ['Billing'] }),
      onPhase,
    });

    // Each pass reports its usage live as it completes.
    expect(onPhase.mock.calls.map((c) => c[0].phase)).toEqual(['outline', 'discovery', 'analysis']);
    expect(onPhase.mock.calls[2][0].usage.costUsd).toBe(0.01);

    expect(mockDiscoverDomainOutline).toHaveBeenCalledTimes(1);
    // Deep pass is focused on the picked domain's entities only.
    expect(mockDiscoverDataModel).toHaveBeenCalledTimes(1);
    expect(mockDiscoverDataModel.mock.calls[0][1].focusEntities).toEqual(['Invoice']);

    expect(report.scope).toEqual({ mode: 'domains', domains: ['Billing'] });
    expect(report.dataModel?.entities.map((e) => e.name)).toEqual(['Invoice']);
    expect(report.analysis).toBe(analysis);
    expect(report.model).toBe('reason-model');

    // Usage is tallied across all three passes (outline + deep + analysis).
    expect(report.usage.phases.map((p) => p.phase)).toEqual(['outline', 'discovery', 'analysis']);
    expect(report.usage.total.inputTokens).toBe(300);
    expect(report.usage.total.outputTokens).toBe(150);
    expect(report.usage.total.costUsd).toBeCloseTo(0.03);
  });

  it('deep-discovers the whole model (no focus) when "all" is picked', async () => {
    mockDiscoverDomainOutline.mockResolvedValue({ discovery: outline, model: 'outline-model', durationMs: 1, usage });
    mockDiscoverDataModel.mockResolvedValue({ discovery: fullModel, model: 'deep-model', durationMs: 1, usage });

    const report = await runFgaScan({
      installDir: '/tmp/app',
      selectScope: async () => ({ mode: 'all' }),
    });

    expect(mockDiscoverDataModel.mock.calls[0][1].focusEntities).toBeUndefined();
    expect(report.scope).toEqual({ mode: 'all' });
    expect(report.dataModel?.entities).toHaveLength(2);
  });

  it('skips the picker and deep pass when the outline finds no entities', async () => {
    mockDiscoverDomainOutline.mockResolvedValue({
      discovery: { source: null, summary: 'empty', entities: [], domains: [] },
      model: 'outline-model',
      durationMs: 1,
      usage,
    });
    const selectScope = vi.fn();

    const report = await runFgaScan({ installDir: '/tmp/app', selectScope });

    expect(selectScope).not.toHaveBeenCalled();
    expect(mockDiscoverDataModel).not.toHaveBeenCalled();
    expect(report.skipped).toBe(true);
    expect(report.analysis).toBeNull();
  });

  it('headless/flagged: full discovery then resolves scope from flags (no outline)', async () => {
    mockDiscoverDataModel.mockResolvedValue({ discovery: fullModel, model: 'full-model', durationMs: 1, usage });

    const report = await runFgaScan({ installDir: '/tmp/app', domains: 'Billing' });

    expect(mockDiscoverDomainOutline).not.toHaveBeenCalled();
    expect(mockDiscoverDataModel).toHaveBeenCalledTimes(1);
    expect(mockDiscoverDataModel.mock.calls[0][1].focusEntities).toBeUndefined();
    expect(report.scope).toEqual({ mode: 'domains', domains: ['Billing'] });
    expect(report.dataModel?.entities.map((e) => e.name)).toEqual(['Invoice']);
  });

  it('does NOT generate code in the core pass (no code option)', async () => {
    mockDiscoverDataModel.mockResolvedValue({ discovery: fullModel, model: 'full-model', durationMs: 1, usage });

    const report = await runFgaScan({ installDir: '/tmp/app', domains: 'Billing' });

    expect(mockParseIntegrationSnippets).not.toHaveBeenCalled();
    expect(report.analysis?.integrationSnippets).toEqual([]);
    expect(report.usage.phases.map((p) => p.phase)).not.toContain('snippets');
  });

  it('runs the integration-code follow-up when code: true', async () => {
    mockDiscoverDataModel.mockResolvedValue({ discovery: fullModel, model: 'full-model', durationMs: 1, usage });
    mockParseIntegrationSnippets.mockReturnValue([
      { title: 'Authorize a route', language: 'javascript', code: 'check()' },
    ]);

    const report = await runFgaScan({ installDir: '/tmp/app', domains: 'Billing', code: true });

    expect(report.analysis?.integrationSnippets).toHaveLength(1);
    // A dedicated 'snippets' usage phase is appended for the extra pass.
    expect(report.usage.phases.map((p) => p.phase)).toContain('snippets');
  });

  it('generateIntegrationSnippets no-ops when there is no analysis', async () => {
    const skeleton = {
      version: '1',
      timestamp: 't',
      target: 'fga' as const,
      project: { path: '/tmp/app', language: null, framework: null },
      dataModelHints: { sources: [] },
      dataModel: null,
      scope: { mode: 'all' as const },
      analysis: null,
      model: 'm',
      usage: { phases: [], total: { ...emptyUsage } },
      durationMs: 1,
    };
    const out = await generateIntegrationSnippets(skeleton, { installDir: '/tmp/app' });
    expect(out).toBe(skeleton);
    expect(mockRunScanAgent).not.toHaveBeenCalled();
  });
});
