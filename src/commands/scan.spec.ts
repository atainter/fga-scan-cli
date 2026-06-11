import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ArgumentsCamelCase } from 'yargs';
import { CliExit } from '../utils/cli-exit.js';
import type { FgaScanReport } from '../scan/fga/types.js';

const mockRunFgaScan = vi.fn();
const mockServeFgaReport = vi.fn();

vi.mock('../scan/fga/index.js', () => ({
  runFgaScan: (...args: unknown[]) => mockRunFgaScan(...args),
  formatFgaReport: vi.fn(),
  formatDiscovery: vi.fn(),
  formatFgaReportAsJson: (report: unknown) => JSON.stringify(report, null, 2),
  generateFgaReportHtml: () => '<html>report</html>',
  serveFgaReport: (...args: unknown[]) => mockServeFgaReport(...args),
}));

vi.mock('../scan/data-model/picker.js', () => ({
  promptForDomain: vi.fn(),
}));

const mockHasCredentials = vi.fn();
vi.mock('../lib/credentials.js', () => ({
  hasCredentials: (...args: unknown[]) => mockHasCredentials(...args),
}));

const mockGetInteractionMode = vi.fn();
vi.mock('../utils/interaction-mode.js', () => ({
  getInteractionMode: (...args: unknown[]) => mockGetInteractionMode(...args),
}));

vi.mock('open', () => ({ default: vi.fn() }));

const mockWriteFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

vi.mock('../utils/clack.js', () => ({
  default: {
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
    log: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
  },
}));

import { handleScanFga, type ScanFgaArgs } from './scan.js';

function report(overrides?: Partial<FgaScanReport>): FgaScanReport {
  return {
    version: '1.0.0',
    timestamp: '2026-01-01T00:00:00.000Z',
    target: 'fga',
    project: { path: '/tmp/app', language: 'JavaScript/TypeScript', framework: null },
    dataModelHints: { sources: [] },
    dataModel: { source: 'prisma', summary: 'ok', entities: [], domains: [] },
    scope: { mode: 'all' },
    analysis: {
      summary: 'ok',
      proposal: { resourceTypes: [], roles: [], exampleChecks: [] },
      recommendations: [],
      integrationSnippets: [],
      warnings: [],
    },
    model: 'claude-test',
    durationMs: 10,
    ...overrides,
  };
}

function argv(args: Partial<ScanFgaArgs>): ArgumentsCamelCase<ScanFgaArgs> {
  return { _: ['scan', 'fga'], $0: 'workos', ...args } as ArgumentsCamelCase<ScanFgaArgs>;
}

async function expectExit(promise: Promise<void>, code: number): Promise<void> {
  try {
    await promise;
    expect.fail('expected CliExit');
  } catch (error) {
    expect(error).toBeInstanceOf(CliExit);
    expect((error as CliExit).exitCode).toBe(code);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHasCredentials.mockReturnValue(true);
  mockGetInteractionMode.mockReturnValue({ mode: 'agent', source: 'non_tty' });
});

describe('handleScanFga', () => {
  it('exits with code 4 when not authenticated', async () => {
    mockHasCredentials.mockReturnValue(false);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expectExit(handleScanFga(argv({ json: true })), 4);
    expect(mockRunFgaScan).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('outputs the report as JSON and exits 0 in json mode', async () => {
    mockRunFgaScan.mockResolvedValue(report());
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expectExit(handleScanFga(argv({ json: true, installDir: '/tmp/app' })), 0);

    const output = consoleLog.mock.calls.map((c) => c[0]).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.target).toBe('fga');
    expect(parsed.analysis.summary).toBe('ok');
    expect(mockRunFgaScan).toHaveBeenCalledWith(expect.objectContaining({ installDir: '/tmp/app' }));

    consoleLog.mockRestore();
  });

  it('exits 1 in json mode when the analysis could not be produced', async () => {
    mockRunFgaScan.mockResolvedValue(report({ analysis: null, skipped: true, skipReason: 'unparseable' }));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expectExit(handleScanFga(argv({ json: true })), 1);

    consoleLog.mockRestore();
  });

  it('writes the HTML report to a fallback path when not opening a browser', async () => {
    mockRunFgaScan.mockResolvedValue(report());

    await expectExit(handleScanFga(argv({ open: false })), 0);

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('workos-fga-scan-'),
      '<html>report</html>',
      'utf-8',
    );
    expect(mockServeFgaReport).not.toHaveBeenCalled();
  });

  it('writes the HTML report to --out when provided', async () => {
    mockRunFgaScan.mockResolvedValue(report());

    await expectExit(handleScanFga(argv({ open: false, out: '/tmp/fga.html' })), 0);

    expect(mockWriteFile).toHaveBeenCalledWith('/tmp/fga.html', '<html>report</html>', 'utf-8');
  });

  it('emits a structured error and exits 1 when the scan throws in json mode', async () => {
    mockRunFgaScan.mockRejectedValue(new Error('gateway unreachable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expectExit(handleScanFga(argv({ json: true })), 1);

    const stderr = consoleError.mock.calls.map((c) => c[0]).join('\n');
    expect(JSON.parse(stderr)).toEqual({
      error: { code: 'scan_failed', message: 'gateway unreachable' },
    });

    consoleError.mockRestore();
  });
});
