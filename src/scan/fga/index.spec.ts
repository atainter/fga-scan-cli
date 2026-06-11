import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataModelDiscovery } from '../data-model/types.js';
import type { FgaAnalysis } from './types.js';

const mockDiscoverDomainOutline = vi.fn();
const mockDiscoverDataModel = vi.fn();
const mockRunScanAgent = vi.fn();
const mockParseFgaAgentOutput = vi.fn();

vi.mock('../../doctor/checks/language.js', () => ({ checkLanguage: () => ({ name: 'JavaScript/TypeScript' }) }));
vi.mock('../../doctor/checks/framework.js', () => ({ checkFramework: () => ({ name: 'Next.js', version: '14' }) }));
vi.mock('./collectors.js', () => ({ collectDataModelHints: () => ({ sources: [] }) }));
vi.mock('../data-model/discover.js', () => ({
  discoverDomainOutline: (...args: unknown[]) => mockDiscoverDomainOutline(...args),
  discoverDataModel: (...args: unknown[]) => mockDiscoverDataModel(...args),
}));
vi.mock('../agent.js', () => ({ runScanAgent: (...args: unknown[]) => mockRunScanAgent(...args) }));
vi.mock('./parse.js', () => ({ parseFgaAgentOutput: (...args: unknown[]) => mockParseFgaAgentOutput(...args) }));

import { runFgaScan } from './index.js';

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
  mockRunScanAgent.mockResolvedValue({ outputText: '```json\n{}\n```', model: 'reason-model', durationMs: 1 });
  mockParseFgaAgentOutput.mockReturnValue(analysis);
});

describe('runFgaScan — pick-a-domain-first ordering', () => {
  it('outlines, then deep-discovers ONLY the picked domain', async () => {
    mockDiscoverDomainOutline.mockResolvedValue({ discovery: outline, model: 'outline-model', durationMs: 1 });
    mockDiscoverDataModel.mockResolvedValue({
      discovery: {
        source: 'prisma',
        summary: 'Deep.',
        entities: [{ name: 'Invoice', filePath: 'prisma/schema.prisma', relationships: [] }],
        domains: [{ name: 'Billing', entities: ['Invoice'] }],
      },
      model: 'deep-model',
      durationMs: 1,
    });

    const report = await runFgaScan({
      installDir: '/tmp/app',
      selectScope: async () => ({ mode: 'domains', domains: ['Billing'] }),
    });

    expect(mockDiscoverDomainOutline).toHaveBeenCalledTimes(1);
    // Deep pass is focused on the picked domain's entities only.
    expect(mockDiscoverDataModel).toHaveBeenCalledTimes(1);
    expect(mockDiscoverDataModel.mock.calls[0][1].focusEntities).toEqual(['Invoice']);

    expect(report.scope).toEqual({ mode: 'domains', domains: ['Billing'] });
    expect(report.dataModel?.entities.map((e) => e.name)).toEqual(['Invoice']);
    expect(report.analysis).toBe(analysis);
    expect(report.model).toBe('reason-model');
  });

  it('deep-discovers the whole model (no focus) when "all" is picked', async () => {
    mockDiscoverDomainOutline.mockResolvedValue({ discovery: outline, model: 'outline-model', durationMs: 1 });
    mockDiscoverDataModel.mockResolvedValue({ discovery: fullModel, model: 'deep-model', durationMs: 1 });

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
    });
    const selectScope = vi.fn();

    const report = await runFgaScan({ installDir: '/tmp/app', selectScope });

    expect(selectScope).not.toHaveBeenCalled();
    expect(mockDiscoverDataModel).not.toHaveBeenCalled();
    expect(report.skipped).toBe(true);
    expect(report.analysis).toBeNull();
  });

  it('headless/flagged: full discovery then resolves scope from flags (no outline)', async () => {
    mockDiscoverDataModel.mockResolvedValue({ discovery: fullModel, model: 'full-model', durationMs: 1 });

    const report = await runFgaScan({ installDir: '/tmp/app', domains: 'Billing' });

    expect(mockDiscoverDomainOutline).not.toHaveBeenCalled();
    expect(mockDiscoverDataModel).toHaveBeenCalledTimes(1);
    expect(mockDiscoverDataModel.mock.calls[0][1].focusEntities).toBeUndefined();
    expect(report.scope).toEqual({ mode: 'domains', domains: ['Billing'] });
    expect(report.dataModel?.entities.map((e) => e.name)).toEqual(['Invoice']);
  });
});
