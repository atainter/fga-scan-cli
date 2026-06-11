import { runScanAgent, type ScanAgentOptions } from '../agent.js';
import { buildDiscoveryPrompt, buildDomainOutlinePrompt, type DiscoveryPromptContext } from './discovery-prompt.js';
import { parseDiscoveryOutput } from './parse.js';
import type { DataModelDiscovery } from './types.js';

export interface DiscoveryResult {
  discovery: DataModelDiscovery | null;
  model: string;
  durationMs: number;
}

/**
 * Phase 1a of a scan: a CHEAP outline pass that lists entities (names + file
 * paths) grouped into domains, so the user can pick a domain before the
 * expensive relationship-extraction runs. Returns a DataModelDiscovery whose
 * entities have empty relationships — the focused deep pass fills those in.
 */
export async function discoverDomainOutline(
  agentOptions: ScanAgentOptions,
  context: DiscoveryPromptContext,
): Promise<DiscoveryResult> {
  const prompt = buildDomainOutlinePrompt(context);
  const result = await runScanAgent(agentOptions, prompt);

  return {
    discovery: parseDiscoveryOutput(result.outputText),
    model: result.model,
    durationMs: result.durationMs,
  };
}

/**
 * Phase 1(b) of a scan: run the read-only agent to inventory the project's
 * data model with relationships. Pass `context.focusEntities` to deep-scan a
 * single domain instead of the whole model. Returns null discovery when the
 * agent output is unparseable.
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
