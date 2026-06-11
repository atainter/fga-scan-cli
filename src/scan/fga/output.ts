import Chalk from 'chalk';
import type { FgaResourceTypeProposal, FgaScanReport } from './types.js';

/**
 * Render the proposed resource hierarchy as an indented tree.
 * Exported for reuse in the HTML report's no-JS fallback.
 */
export function renderHierarchyTree(resourceTypes: FgaResourceTypeProposal[]): string[] {
  const childrenOf = new Map<string | null, FgaResourceTypeProposal[]>();
  for (const rt of resourceTypes) {
    const list = childrenOf.get(rt.parent) ?? [];
    list.push(rt);
    childrenOf.set(rt.parent, list);
  }

  const lines: string[] = [];
  const visit = (node: FgaResourceTypeProposal, prefix: string, isLast: boolean, isRoot: boolean): void => {
    const connector = isRoot ? '' : isLast ? '└── ' : '├── ';
    lines.push(`${prefix}${connector}${node.displayName} (${node.type})`);
    const children = childrenOf.get(node.type) ?? [];
    const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
    children.forEach((child, i) => visit(child, childPrefix, i === children.length - 1, false));
  };

  const roots = childrenOf.get(null) ?? [];
  roots.forEach((root) => visit(root, '', true, true));
  return lines;
}

export function formatFgaReport(report: FgaScanReport): void {
  console.log('');
  console.log(Chalk.cyan('WorkOS FGA Scan'));
  console.log(Chalk.dim('━'.repeat(70)));

  console.log('');
  console.log('Project');
  console.log(`   Path:             ${report.project.path}`);
  if (report.project.language) {
    console.log(`   Language:         ${report.project.language}`);
  }
  if (report.project.framework) {
    console.log(`   Framework:        ${report.project.framework}`);
  }
  if (report.dataModelHints.sources.length > 0) {
    console.log(`   Schema sources:   ${report.dataModelHints.sources.map((s) => s.kind).join(', ')}`);
  }

  const analysis = report.analysis;
  if (!analysis) {
    console.log('');
    console.log(`   ${Chalk.yellow('!')} ${report.skipReason ?? 'No analysis produced'}`);
    return;
  }

  if (analysis.summary) {
    console.log('');
    console.log('Summary');
    console.log(`   ${analysis.summary}`);
  }

  if (analysis.proposal.resourceTypes.length > 0) {
    console.log('');
    console.log('Proposed Resource Hierarchy');
    for (const line of renderHierarchyTree(analysis.proposal.resourceTypes)) {
      console.log(`   ${line}`);
    }
  }

  if (analysis.proposal.roles.length > 0) {
    console.log('');
    console.log('Proposed Roles');
    for (const role of analysis.proposal.roles) {
      const cascade = role.cascades ? Chalk.dim(' (cascades to children)') : '';
      console.log(`   ${Chalk.bold(role.name)} on ${role.resourceType}${cascade}`);
      console.log(`     ${Chalk.dim(role.permissions.join(', '))}`);
    }
  }

  if (analysis.proposal.exampleChecks.length > 0) {
    console.log('');
    console.log('Example Access Checks');
    for (const check of analysis.proposal.exampleChecks) {
      const verdict = check.expected ? Chalk.green('allow') : Chalk.red('deny');
      console.log(`   ${verdict}  ${check.subject} → ${check.permission} on ${check.resource}`);
      if (check.path) {
        console.log(`         ${Chalk.dim(check.path)}`);
      }
    }
  }

  if (analysis.recommendations.length > 0) {
    console.log('');
    console.log('Recommendations');
    for (const rec of analysis.recommendations) {
      const badge =
        rec.priority === 'high'
          ? Chalk.red('[high]')
          : rec.priority === 'low'
            ? Chalk.dim('[low]')
            : Chalk.yellow('[medium]');
      console.log(`   ${badge} ${Chalk.bold(rec.title)}`);
      console.log(`     ${rec.detail}`);
    }
  }

  if (analysis.warnings.length > 0) {
    console.log('');
    console.log('Warnings');
    for (const warning of analysis.warnings) {
      console.log(`   ${Chalk.yellow('!')} ${warning}`);
    }
  }

  console.log('');
  console.log(Chalk.dim(`Model: ${report.model} · ${Math.round(report.durationMs / 1000)}s`));
  console.log(Chalk.dim('Learn more: https://workos.com/docs/fga'));
}
