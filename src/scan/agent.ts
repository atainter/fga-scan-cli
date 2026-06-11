import Anthropic from '@anthropic-ai/sdk';
import { initializeAgent, runAgent } from '../lib/agent-interface.js';
import { getConfig, getLlmGatewayUrl, getAuthkitDomain, getCliAuthClientId } from '../lib/settings.js';
import { getCredentials, isTokenExpired, updateTokens } from '../lib/credentials.js';
import { refreshAccessToken } from '../lib/token-refresh-client.js';
import { formatWorkOSCommand } from '../utils/command-invocation.js';
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

/** Token/cost accounting for a single agent pass. */
export interface ScanUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  numTurns: number;
}

export const EMPTY_SCAN_USAGE: ScanUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  numTurns: 0,
};

/** Sum a list of per-pass usages into one total. */
export function sumScanUsage(usages: ScanUsage[]): ScanUsage {
  return usages.reduce<ScanUsage>(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + u.cacheCreationTokens,
      costUsd: acc.costUsd + u.costUsd,
      numTurns: acc.numTurns + u.numTurns,
    }),
    { ...EMPTY_SCAN_USAGE },
  );
}

export interface ScanAgentResult {
  /** Full text the agent produced; the final fenced JSON block is the analysis */
  outputText: string;
  model: string;
  durationMs: number;
  usage: ScanUsage;
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
  // Scans are read-only analysis, not code generation — run them on the small,
  // fast scan model (like doctor) rather than the heavier installer model.
  agentConfig.model = getConfig().scanModel;
  // Drop the WorkOS docs MCP server: every pass would otherwise spawn
  // `npx @workos/mcp-docs-server`, and the scan needs no docs — the FGA
  // knowledge is in the prompt and it only reads the customer's code. This
  // removes a large chunk of per-pass startup latency.
  agentConfig.mcpServers = {};

  const collected: string[] = [];
  let resultText = '';
  let usage: ScanUsage = { ...EMPTY_SCAN_USAGE };
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
    if (message.type === 'result') {
      if (message.subtype === 'success' && typeof message.result === 'string') {
        resultText = message.result;
      }
      // The result message carries cumulative usage + cost for the whole pass.
      usage = {
        inputTokens: message.usage.input_tokens ?? 0,
        outputTokens: message.usage.output_tokens ?? 0,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
        costUsd: message.total_cost_usd ?? 0,
        numTurns: message.num_turns ?? 0,
      };
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

  return { outputText, model: agentConfig.model, durationMs, usage };
}

export interface ScanModelOptions {
  /** Bypass the gateway and use ANTHROPIC_API_KEY directly. */
  direct?: boolean;
  onStatus?: (message: string) => void;
  spinnerMessage?: string;
}

/**
 * Run a single, tool-free model call over a prompt — like `workos doctor`'s AI
 * analysis. No agent SDK, MCP server, or turn loop, so it's much faster than
 * runScanAgent for a pure reasoning step that needs no file access. Used for
 * the FGA analysis pass, which reasons entirely from the discovery inventory.
 */
export async function runScanModel(options: ScanModelOptions, prompt: string): Promise<ScanAgentResult> {
  if (options.spinnerMessage) options.onStatus?.(options.spinnerMessage);
  const model = getConfig().scanModel;
  const startTime = Date.now();

  let client: Anthropic;
  if (options.direct) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when using --direct');
    client = new Anthropic({ apiKey });
  } else {
    let creds = getCredentials();
    if (!creds) throw new Error(`Not authenticated — run \`${formatWorkOSCommand('auth login')}\``);
    if (isTokenExpired(creds)) {
      const refreshed = creds.refreshToken
        ? await refreshAccessToken(getAuthkitDomain(), getCliAuthClientId())
        : null;
      if (!refreshed?.success || !refreshed.accessToken || !refreshed.expiresAt) {
        throw new Error(`Session expired — run \`${formatWorkOSCommand('auth login')}\` to re-authenticate`);
      }
      updateTokens(refreshed.accessToken, refreshed.expiresAt, refreshed.refreshToken);
      creds = getCredentials()!;
    }
    client = new Anthropic({
      baseURL: getLlmGatewayUrl(),
      apiKey: 'gateway',
      defaultHeaders: { Authorization: `Bearer ${creds.accessToken}` },
    });
  }

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });

  const outputText = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  const u = response.usage;
  const usage: ScanUsage = {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    // The raw Messages API doesn't return a dollar cost (unlike the agent SDK).
    costUsd: 0,
    numTurns: 1,
  };

  return { outputText, model, durationMs: Date.now() - startTime, usage };
}
