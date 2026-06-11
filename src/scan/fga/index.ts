import { checkLanguage } from '../../doctor/checks/language.js';
import { checkFramework } from '../../doctor/checks/framework.js';
import { collectDataModelHints } from './collectors.js';
import { buildFgaScanPrompt, buildIntegrationSnippetsPrompt } from './agent-prompt.js';
import { runScanAgent, sumScanUsage, type ScanUsage } from '../agent.js';
import { discoverDataModel, discoverDomainOutline } from '../data-model/discover.js';
import { applyScope, resolveScopeFromFlags } from '../data-model/scope.js';
import { parseFgaAgentOutput, parseIntegrationSnippets } from './parse.js';
import type { DataModelDiscovery, ScopeSelection } from '../data-model/types.js';
import type { FgaScanOptions, FgaScanReport, FgaScanUsage, ScanPhaseUsage } from './types.js';
import type { DoctorOptions } from '../../doctor/types.js';

export const FGA_SCAN_VERSION = '1.0.0';

/**
 * Scan flow (pick-a-domain-first):
 *   1a. Outline — a cheap read-only pass lists entities + domains (no
 *       relationships) so the user can pick a domain up front. Interactive,
 *       unflagged runs only.
 *   1b. Deep discovery — extracts relationships for the picked domain only
 *       (or the whole model for headless/flagged/"all" runs).
 *   2.  Analysis — a second agent pass proposes an FGA model for the scoped
 *       entities only.
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

  const baseFields = {
    version: FGA_SCAN_VERSION,
    timestamp: new Date().toISOString(),
    target: 'fga' as const,
    project: {
      path: options.installDir,
      language: language.name ?? null,
      framework: framework.name,
    },
    dataModelHints,
  };

  // Accumulate per-pass token/cost usage. tally() summarizes whatever passes
  // ran by the time we return — including the early-skip paths.
  const phases: ScanPhaseUsage[] = [];
  const tally = (): FgaScanUsage => ({ phases, total: sumScanUsage(phases.map((p) => p.usage)) });
  // Record a finished pass and surface its tokens/cost as a live status update.
  const recordPhase = (phase: string, r: { model: string; durationMs: number; usage: ScanUsage }): void => {
    const entry = { phase, model: r.model, durationMs: r.durationMs, usage: r.usage };
    phases.push(entry);
    options.onPhase?.(entry);
  };

  const noModel = (model: string, dataModel: DataModelDiscovery | null, scope: ScopeSelection, reason: string): FgaScanReport => ({
    ...baseFields,
    model,
    usage: tally(),
    dataModel,
    scope,
    analysis: null,
    durationMs: Date.now() - startTime,
    skipped: true,
    skipReason: reason,
  });

  // Phase 1: produce the (scoped) data model to analyze. Two routes:
  //  - Interactive + no flags: cheap OUTLINE → user picks a domain → focused
  //    deep discovery, so relationship extraction only runs on the chosen domain.
  //  - Headless / flagged: full discovery, then resolve scope from flags (or all).
  const hasFlags = Boolean(options.domains || options.entities);
  let discovery: DataModelDiscovery | null;
  let discoveryModel: string;
  let scope: ScopeSelection = { mode: 'all' };
  let scopeWarnings: string[] | undefined;

  if (options.selectScope && !hasFlags) {
    onStatus('Outlining your data model...');
    const outlineResult = await discoverDomainOutline(
      { ...agentOptions, spinnerMessage: 'Outlining your data model...' },
      { language, framework, dataModelHints },
    );
    recordPhase('outline', outlineResult);
    const outline = outlineResult.discovery;
    if (!outline) {
      return noModel(outlineResult.model, null, scope, 'Data model discovery did not produce a structured inventory');
    }
    if (outline.entities.length === 0) {
      return noModel(outlineResult.model, outline, scope, outline.summary || 'No persistent entities were found in this project');
    }

    // The user picks a single domain (or the whole app) BEFORE the expensive pass.
    scope = await options.selectScope(outline);
    const focusEntities =
      scope.mode === 'domains'
        ? outline.domains.filter((d) => (scope.domains ?? []).includes(d.name)).flatMap((d) => d.entities)
        : scope.mode === 'entities'
          ? scope.entities
          : undefined;

    onStatus('Analyzing your data model...');
    const deepResult = await discoverDataModel(
      { ...agentOptions, spinnerMessage: 'Analyzing your data model...' },
      { language, framework, dataModelHints, focusEntities },
    );
    recordPhase('discovery', deepResult);
    discoveryModel = deepResult.model;
    // Keep the deep result as-is. For a focused domain it intentionally includes
    // the ancestor entities up to the organization root, so the proposed FGA
    // hierarchy stays connected from the tenant down to the domain.
    discovery = deepResult.discovery;
  } else {
    onStatus('Discovering your data model...');
    const discoveryResult = await discoverDataModel(
      { ...agentOptions, spinnerMessage: 'Discovering your data model...' },
      { language, framework, dataModelHints },
    );
    recordPhase('discovery', discoveryResult);
    discoveryModel = discoveryResult.model;
    const full = discoveryResult.discovery;
    if (!full) {
      return noModel(discoveryModel, null, scope, 'Data model discovery did not produce a structured inventory');
    }
    if (full.entities.length === 0) {
      return noModel(discoveryModel, full, scope, full.summary || 'No persistent entities were found in this project');
    }

    const flagScope = resolveScopeFromFlags(full, { domains: options.domains, entities: options.entities });
    if (flagScope) {
      scope = flagScope.selection;
      if (flagScope.unknown.length > 0) {
        scopeWarnings = flagScope.unknown.map((name) => `Unknown ${scope.mode === 'domains' ? 'domain' : 'entity'}: "${name}"`);
      }
    }
    discovery = applyScope(full, scope);
  }

  const baseReport = { ...baseFields, model: discoveryModel };

  if (!discovery || discovery.entities.length === 0) {
    return {
      ...baseReport,
      usage: tally(),
      dataModel: discovery,
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
  const prompt = buildFgaScanPrompt({ dataModel: discovery, scope });
  const analysisResult = await runScanAgent(
    { ...agentOptions, spinnerMessage: 'Analyzing FGA fit for the scoped model...' },
    prompt,
  );

  recordPhase('analysis', analysisResult);
  const analysis = parseFgaAgentOutput(analysisResult.outputText);

  const report: FgaScanReport = {
    ...baseReport,
    dataModel: discovery,
    scope,
    scopeWarnings,
    analysis,
    model: analysisResult.model,
    usage: tally(),
    durationMs: Date.now() - startTime,
    ...(analysis === null
      ? { skipped: true, skipReason: 'Agent output could not be parsed into a structured analysis' }
      : {}),
  };

  // Integration code is an opt-in follow-up — only run it when asked, so the
  // core model comes back fast. Headless/JSON callers pass `code: true`.
  return options.code ? generateIntegrationSnippets(report, options) : report;
}

/**
 * Opt-in follow-up: generate concrete SDK integration code for the model a core
 * scan already proposed. Runs a separate read-only agent pass and returns the
 * report with `analysis.integrationSnippets` populated and a `snippets` usage
 * phase appended. No-ops (returns the report unchanged) when there's no analysis
 * or data model to work from.
 */
export async function generateIntegrationSnippets(
  report: FgaScanReport,
  options: Pick<FgaScanOptions, 'installDir' | 'direct' | 'debug' | 'onStatus' | 'onPhase'>,
): Promise<FgaScanReport> {
  if (!report.analysis || !report.dataModel) return report;

  const onStatus = options.onStatus ?? (() => {});
  onStatus('Generating integration code...');

  const result = await runScanAgent(
    {
      installDir: options.installDir,
      direct: options.direct,
      debug: options.debug,
      onStatus,
      spinnerMessage: 'Generating integration code...',
    },
    buildIntegrationSnippetsPrompt({ dataModel: report.dataModel, proposal: report.analysis.proposal }),
  );

  const phase = { phase: 'snippets', model: result.model, durationMs: result.durationMs, usage: result.usage };
  options.onPhase?.(phase);
  const phases = [...report.usage.phases, phase];

  return {
    ...report,
    analysis: { ...report.analysis, integrationSnippets: parseIntegrationSnippets(result.outputText) },
    usage: { phases, total: sumScanUsage(phases.map((p) => p.usage)) },
  };
}

export { formatFgaReport, formatDiscovery, formatUsageLine, formatIntegrationSnippets } from './output.js';
export { formatFgaReportAsJson } from './json-output.js';
export { generateFgaReportHtml } from './html-report.js';
export { serveFgaReport } from './report-server.js';
export type { FgaScanReport, FgaScanOptions, FgaAnalysis } from './types.js';
