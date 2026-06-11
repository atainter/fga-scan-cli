import { checkLanguage } from '../../doctor/checks/language.js';
import { checkFramework } from '../../doctor/checks/framework.js';
import { collectDataModelHints } from './collectors.js';
import { buildFgaScanPrompt } from './agent-prompt.js';
import { runScanAgent } from '../agent.js';
import { discoverDataModel } from '../data-model/discover.js';
import { applyScope, resolveScopeFromFlags } from '../data-model/scope.js';
import { parseFgaAgentOutput } from './parse.js';
import type { ScopeSelection } from '../data-model/types.js';
import type { FgaScanOptions, FgaScanReport } from './types.js';
import type { DoctorOptions } from '../../doctor/types.js';

export const FGA_SCAN_VERSION = '1.0.0';

/**
 * Two-phase scan:
 *   1. Discovery — a read-only agent inventories the data model, then the
 *      user narrows it (interactive picker via options.selectScope, or
 *      --domains/--entities flags, or everything by default).
 *   2. Analysis — a second agent pass proposes an FGA model for the scoped
 *      entities only.
 */
export async function runFgaScan(options: FgaScanOptions): Promise<FgaScanReport> {
  const startTime = Date.now();
  const onStatus = options.onStatus ?? (() => {});

  onStatus('Detecting project shape...');
  const [language, framework, dataModelHints] = await Promise.all([
    checkLanguage(options.installDir),
    checkFramework({ installDir: options.installDir } as DoctorOptions),
    collectDataModelHints(options.installDir),
  ]);

  const agentOptions = {
    installDir: options.installDir,
    direct: options.direct,
    debug: options.debug,
    onStatus,
  };

  // Phase 1: discover the data model
  onStatus('Discovering your data model...');
  const discoveryResult = await discoverDataModel(
    { ...agentOptions, spinnerMessage: 'Discovering your data model...' },
    { language, framework, dataModelHints },
  );

  const baseReport = {
    version: FGA_SCAN_VERSION,
    timestamp: new Date().toISOString(),
    target: 'fga' as const,
    project: {
      path: options.installDir,
      language: language.name ?? null,
      framework: framework.name,
    },
    dataModelHints,
    model: discoveryResult.model,
  };

  if (!discoveryResult.discovery) {
    return {
      ...baseReport,
      dataModel: null,
      scope: { mode: 'all' },
      analysis: null,
      durationMs: Date.now() - startTime,
      skipped: true,
      skipReason: 'Data model discovery did not produce a structured inventory',
    };
  }

  const discovery = discoveryResult.discovery;

  if (discovery.entities.length === 0) {
    return {
      ...baseReport,
      dataModel: discovery,
      scope: { mode: 'all' },
      analysis: null,
      durationMs: Date.now() - startTime,
      skipped: true,
      skipReason: discovery.summary || 'No persistent entities were found in this project',
    };
  }

  // Scope: flags win, then the interactive hook, then everything
  let scope: ScopeSelection = { mode: 'all' };
  let scopeWarnings: string[] | undefined;
  const flagScope = resolveScopeFromFlags(discovery, { domains: options.domains, entities: options.entities });
  if (flagScope) {
    scope = flagScope.selection;
    if (flagScope.unknown.length > 0) {
      scopeWarnings = flagScope.unknown.map((name) => `Unknown ${scope.mode === 'domains' ? 'domain' : 'entity'}: "${name}"`);
    }
  } else if (options.selectScope) {
    scope = await options.selectScope(discovery);
  }

  const scopedModel = applyScope(discovery, scope);

  if (scopedModel.entities.length === 0) {
    return {
      ...baseReport,
      dataModel: scopedModel,
      scope,
      scopeWarnings,
      analysis: null,
      durationMs: Date.now() - startTime,
      skipped: true,
      skipReason: 'The selected scope matched no entities',
    };
  }

  // Phase 2: FGA analysis over the scoped model
  onStatus('Analyzing FGA fit for the scoped model...');
  const prompt = buildFgaScanPrompt({ dataModel: scopedModel });
  const analysisResult = await runScanAgent(
    { ...agentOptions, spinnerMessage: 'Analyzing FGA fit for the scoped model...' },
    prompt,
  );

  const analysis = parseFgaAgentOutput(analysisResult.outputText);

  return {
    ...baseReport,
    dataModel: scopedModel,
    scope,
    scopeWarnings,
    analysis,
    model: analysisResult.model,
    durationMs: Date.now() - startTime,
    ...(analysis === null
      ? { skipped: true, skipReason: 'Agent output could not be parsed into a structured analysis' }
      : {}),
  };
}

export { formatFgaReport, formatDiscovery } from './output.js';
export { formatFgaReportAsJson } from './json-output.js';
export { generateFgaReportHtml } from './html-report.js';
export { serveFgaReport } from './report-server.js';
export type { FgaScanReport, FgaScanOptions, FgaAnalysis } from './types.js';
