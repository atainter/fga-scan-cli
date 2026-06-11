import { checkLanguage } from '../../doctor/checks/language.js';
import { checkFramework } from '../../doctor/checks/framework.js';
import { collectDataModelHints } from './collectors.js';
import { buildFgaScanPrompt } from './agent-prompt.js';
import { runScanAgent } from './agent.js';
import { parseFgaAgentOutput } from './parse.js';
import type { FgaScanOptions, FgaScanReport } from './types.js';
import type { DoctorOptions } from '../../doctor/types.js';

export const FGA_SCAN_VERSION = '1.0.0';

export async function runFgaScan(options: FgaScanOptions): Promise<FgaScanReport> {
  const startTime = Date.now();
  const onStatus = options.onStatus ?? (() => {});

  onStatus('Detecting project shape...');
  const [language, framework, dataModelHints] = await Promise.all([
    checkLanguage(options.installDir),
    checkFramework({ installDir: options.installDir } as DoctorOptions),
    collectDataModelHints(options.installDir),
  ]);

  const prompt = buildFgaScanPrompt({
    installDir: options.installDir,
    language,
    framework,
    dataModelHints,
  });

  onStatus('Exploring your data model with AI...');
  const agentResult = await runScanAgent(
    {
      installDir: options.installDir,
      direct: options.direct,
      debug: options.debug,
      onStatus,
    },
    prompt,
  );

  const analysis = parseFgaAgentOutput(agentResult.outputText);

  return {
    version: FGA_SCAN_VERSION,
    timestamp: new Date().toISOString(),
    target: 'fga',
    project: {
      path: options.installDir,
      language: language.name ?? null,
      framework: framework.name,
    },
    dataModelHints,
    analysis,
    model: agentResult.model,
    durationMs: Date.now() - startTime,
    ...(analysis === null
      ? { skipped: true, skipReason: 'Agent output could not be parsed into a structured analysis' }
      : {}),
  };
}

export { formatFgaReport } from './output.js';
export { formatFgaReportAsJson } from './json-output.js';
export { generateFgaReportHtml } from './html-report.js';
export { serveFgaReport } from './report-server.js';
export type { FgaScanReport, FgaScanOptions, FgaAnalysis } from './types.js';
