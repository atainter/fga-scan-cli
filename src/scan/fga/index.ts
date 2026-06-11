import { checkLanguage } from '../../doctor/checks/language.js';
import { checkFramework } from '../../doctor/checks/framework.js';
import { collectDataModelHints } from './collectors.js';
import { buildFgaScanPrompt } from './agent-prompt.js';
import { runScanAgent } from '../agent.js';
import { discoverDataModel, discoverDomainOutline } from '../data-model/discover.js';
import { applyScope, resolveScopeFromFlags } from '../data-model/scope.js';
import { parseFgaAgentOutput } from './parse.js';
import type { DataModelDiscovery, ScopeSelection } from '../data-model/types.js';
import type { FgaScanOptions, FgaScanReport } from './types.js';
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

  const noModel = (model: string, dataModel: DataModelDiscovery | null, scope: ScopeSelection, reason: string): FgaScanReport => ({
    ...baseFields,
    model,
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
    discoveryModel = deepResult.model;
    // Tidy any strays the focused pass pulled in beyond the picked entities.
    discovery = deepResult.discovery
      ? focusEntities
        ? applyScope(deepResult.discovery, { mode: 'entities', entities: focusEntities })
        : deepResult.discovery
      : null;
  } else {
    onStatus('Discovering your data model...');
    const discoveryResult = await discoverDataModel(
      { ...agentOptions, spinnerMessage: 'Discovering your data model...' },
      { language, framework, dataModelHints },
    );
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
  const prompt = buildFgaScanPrompt({ dataModel: discovery });
  const analysisResult = await runScanAgent(
    { ...agentOptions, spinnerMessage: 'Analyzing FGA fit for the scoped model...' },
    prompt,
  );

  const analysis = parseFgaAgentOutput(analysisResult.outputText);

  return {
    ...baseReport,
    dataModel: discovery,
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
