import type { ArgumentsCamelCase } from 'yargs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import open from 'open';
import clack from '../utils/clack.js';
import { ExitCode, exitWithCode, exitWithAuthRequired } from '../utils/exit-codes.js';
import { CliExit } from '../utils/cli-exit.js';
import { hasCredentials } from '../lib/credentials.js';
import { getInteractionMode } from '../utils/interaction-mode.js';
import {
  runFgaScan,
  formatFgaReport,
  formatDiscovery,
  formatFgaReportAsJson,
  generateFgaReportHtml,
  serveFgaReport,
} from '../scan/fga/index.js';
import { promptForScope } from '../scan/data-model/picker.js';

export interface ScanFgaArgs {
  installDir?: string;
  json?: boolean;
  open?: boolean;
  out?: string;
  domains?: string;
  entities?: string;
  direct?: boolean;
  debug?: boolean;
}

export async function handleScanFga(argv: ArgumentsCamelCase<ScanFgaArgs>): Promise<void> {
  const json = argv.json ?? false;
  const installDir = argv.installDir ?? process.cwd();
  const interactive = getInteractionMode().mode === 'human';
  const shouldOpen = (argv.open ?? true) && interactive && !json;

  // The scan agent runs through the WorkOS LLM gateway, which needs CLI
  // credentials — fail fast with exit code 4 rather than mid-scan.
  if (!argv.direct && !hasCredentials()) {
    exitWithAuthRequired();
  }

  const spinner = json ? null : clack.spinner();
  spinner?.start('Scanning project for FGA modeling...');

  try {
    const report = await runFgaScan({
      installDir,
      json,
      direct: argv.direct,
      debug: argv.debug,
      domains: argv.domains,
      entities: argv.entities,
      onStatus: (message) => spinner?.message(message),
      // Interactive scoping between discovery and analysis — human mode only;
      // headless runs scope via --domains/--entities or analyze everything.
      selectScope:
        interactive && !json
          ? async (discovery) => {
              spinner?.stop('Data model discovered');
              formatDiscovery(discovery);
              const selection = await promptForScope(discovery);
              if (selection === null) {
                exitWithCode(ExitCode.CANCELLED);
              }
              spinner?.start('Analyzing FGA fit...');
              return selection;
            }
          : undefined,
    });
    spinner?.stop('Scan complete');

    if (json) {
      console.log(formatFgaReportAsJson(report));
      exitWithCode(report.analysis ? ExitCode.SUCCESS : ExitCode.GENERAL_ERROR);
    }

    formatFgaReport(report);

    if (!report.analysis) {
      exitWithCode(ExitCode.GENERAL_ERROR);
    }

    const html = generateFgaReportHtml(report);

    if (argv.out) {
      await writeFile(argv.out, html, 'utf-8');
      clack.log.success(`HTML report written to ${argv.out}`);
    }

    if (shouldOpen) {
      const server = await serveFgaReport(html, formatFgaReportAsJson(report));
      clack.log.info(`Report available at ${server.url} — press Ctrl+C to close`);
      try {
        await open(server.url, { wait: false });
      } catch {
        clack.log.info('Could not open browser — open the URL above manually.');
      }
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
      });
      await server.close();
    } else if (!argv.out) {
      // Headless / --no-open with no explicit output: persist somewhere findable
      const fallbackPath = join(tmpdir(), `workos-fga-scan-${Date.now()}.html`);
      await writeFile(fallbackPath, html, 'utf-8');
      clack.log.info(`HTML report written to ${fallbackPath}`);
    }

    exitWithCode(ExitCode.SUCCESS);
  } catch (error) {
    spinner?.stop('Scan failed');
    if (error instanceof CliExit) throw error;
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (json) {
      console.error(JSON.stringify({ error: { code: 'scan_failed', message } }));
    } else {
      clack.log.error(`FGA scan failed: ${message}`);
    }
    exitWithCode(ExitCode.GENERAL_ERROR);
  }
}
