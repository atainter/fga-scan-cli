import { initializeAgent, runAgent } from '../lib/agent-interface.js';
import { createInstallerEventEmitter } from '../lib/events.js';
import type { InstallerOptions } from '../utils/types.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Tools the scan agent may use. Exploration only — no Write/Edit/Bash, so the
 * scan can never modify the customer's project or execute commands.
 */
export const SCAN_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'];

export interface ScanAgentOptions {
  installDir: string;
  direct?: boolean;
  debug?: boolean;
  onStatus?: (message: string) => void;
  /** Shown while the agent works; phases pass their own (e.g. "Discovering data model...") */
  spinnerMessage?: string;
}

export interface ScanAgentResult {
  /** Full text the agent produced; the final fenced JSON block is the analysis */
  outputText: string;
  model: string;
  durationMs: number;
}

/**
 * Run a read-only exploration agent over the project. Reuses the installer's
 * agent plumbing (gateway auth, credential proxy, direct mode) but restricts
 * the toolset to read-only exploration.
 */
export async function runScanAgent(options: ScanAgentOptions, prompt: string): Promise<ScanAgentResult> {
  const emitter = createInstallerEventEmitter();
  if (options.onStatus) {
    const onStatus = options.onStatus;
    emitter.on('agent:progress', ({ step }) => onStatus(step));
    emitter.on('status', ({ message }) => onStatus(message));
  }

  const installerOptions: InstallerOptions = {
    debug: options.debug ?? false,
    forceInstall: false,
    installDir: options.installDir,
    local: false,
    ci: false,
    skipAuth: false,
    direct: options.direct,
    emitter,
  };

  const agentConfig = await initializeAgent(
    {
      workingDirectory: options.installDir,
      workOSApiKey: '',
      workOSApiHost: 'https://api.workos.com',
    },
    installerOptions,
  );

  // Override the installer's read-write toolset — scans never modify the project
  agentConfig.allowedTools = SCAN_ALLOWED_TOOLS;

  const collected: string[] = [];
  let resultText = '';
  const onMessage = (message: SDKMessage): void => {
    if (message.type === 'assistant') {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            collected.push(block.text);
          }
        }
      }
    }
    if (message.type === 'result' && message.subtype === 'success' && typeof message.result === 'string') {
      resultText = message.result;
    }
  };

  const startTime = Date.now();
  const agentResult = await runAgent(
    agentConfig,
    prompt,
    installerOptions,
    {
      spinnerMessage: options.spinnerMessage ?? 'Scanning your project...',
      errorMessage: 'Scan failed',
    },
    emitter,
    undefined,
    onMessage,
  );
  const durationMs = Date.now() - startTime;

  if (agentResult.error) {
    throw new Error(agentResult.errorMessage ?? agentResult.error);
  }

  // Prefer the final result message (the agent's last response, which the
  // prompt requires to end with the JSON block); fall back to all turns.
  const outputText = resultText || collected.join('\n');

  return { outputText, model: agentConfig.model, durationMs };
}
