import type { FgaScanReport } from './types.js';

export function formatFgaReportAsJson(report: FgaScanReport): string {
  return JSON.stringify(report, null, 2);
}
