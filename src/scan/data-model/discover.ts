import { runScanAgent, type ScanAgentOptions } from '../agent.js';
import { buildDiscoveryPrompt, type DiscoveryPromptContext } from './discovery-prompt.js';
import { parseDiscoveryOutput } from './parse.js';
import type { DataModelDiscovery } from './types.js';

export interface DiscoveryResult {
  discovery: DataModelDiscovery | null;
  model: string;
  durationMs: number;
}

/**
 * Phase 1 of a scan: run the read-only agent to inventory the project's
 * data model. Returns null discovery when the agent output is unparseable.
 */
export async function discoverDataModel(
  agentOptions: ScanAgentOptions,
  context: DiscoveryPromptContext,
): Promise<DiscoveryResult> {
  const prompt = buildDiscoveryPrompt(context);
  const result = await runScanAgent(agentOptions, prompt);

  return {
    discovery: parseDiscoveryOutput(result.outputText),
    model: result.model,
    durationMs: result.durationMs,
  };
}
