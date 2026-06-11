import { renderHierarchyTree } from './output.js';
import type { DataModelDiscovery } from '../data-model/types.js';
import type { FgaRoleProposal, FgaScanReport } from './types.js';

const FGA_DOCS_URL = 'https://workos.com/docs/fga';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Mermaid node ids must be simple identifiers */
function mermaidId(type: string): string {
  return type.replace(/[^a-zA-Z0-9_]/g, '_') || 'node';
}

/** Mermaid label text — strip characters that break inline labels */
function mermaidLabel(value: string): string {
  return value.replace(/["[\]{}|]/g, '');
}

const ER_CARDINALITY: Record<string, string> = {
  hasMany: '||--o{',
  hasOne: '||--||',
  belongsTo: '}o--||',
  manyToMany: '}o--o{',
};

/**
 * Build a Mermaid ER diagram of the scoped data model. Inverse pairs
 * (A hasMany B / B belongsTo A) are deduplicated to one edge.
 */
export function buildErDiagramMermaid(dataModel: DataModelDiscovery): string {
  if (dataModel.entities.length === 0) return '';

  const lines = ['erDiagram'];
  for (const entity of dataModel.entities) {
    lines.push(`  ${mermaidId(entity.name)}`);
  }

  const seenPairs = new Set<string>();
  for (const entity of dataModel.entities) {
    for (const rel of entity.relationships) {
      const pairKey = [entity.name, rel.to].sort().join('::');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const cardinality = ER_CARDINALITY[rel.kind] ?? '||--o{';
      const label = mermaidLabel(rel.via ?? rel.kind);
      lines.push(`  ${mermaidId(entity.name)} ${cardinality} ${mermaidId(rel.to)} : "${label}"`);
    }
  }
  return lines.join('\n');
}

/**
 * Build the Mermaid flowchart for the proposed hierarchy. Each node shows the
 * resource type and the roles scoped to it; edges follow parent → child.
 */
export function buildHierarchyMermaid(report: FgaScanReport): string {
  const analysis = report.analysis;
  if (!analysis || analysis.proposal.resourceTypes.length === 0) return '';

  const rolesByType = new Map<string, FgaRoleProposal[]>();
  for (const role of analysis.proposal.roles) {
    const list = rolesByType.get(role.resourceType) ?? [];
    list.push(role);
    rolesByType.set(role.resourceType, list);
  }

  const lines = ['graph TD'];
  for (const rt of analysis.proposal.resourceTypes) {
    const roles = rolesByType.get(rt.type) ?? [];
    const roleText = roles.length > 0 ? `<br/><i>${roles.map((r) => mermaidLabel(r.name)).join(', ')}</i>` : '';
    lines.push(`  ${mermaidId(rt.type)}["<b>${mermaidLabel(rt.displayName)}</b>${roleText}"]`);
  }
  for (const rt of analysis.proposal.resourceTypes) {
    if (rt.parent) {
      lines.push(`  ${mermaidId(rt.parent)} --> ${mermaidId(rt.type)}`);
    }
  }
  lines.push('  classDef resource fill:#f5f5ff,stroke:#6363f1,stroke-width:1.5px,rx:8,ry:8,color:#1a1a2e;');
  lines.push(`  class ${analysis.proposal.resourceTypes.map((rt) => mermaidId(rt.type)).join(',')} resource;`);
  return lines.join('\n');
}

export function generateFgaReportHtml(report: FgaScanReport): string {
  const analysis = report.analysis;
  const project = escapeHtml(report.project.path);

  const summarySection = analysis?.summary
    ? `<section><h2>Summary</h2><p>${escapeHtml(analysis.summary)}</p></section>`
    : '';

  const erMermaid = report.dataModel ? buildErDiagramMermaid(report.dataModel) : '';
  const scopeLabel =
    report.scope.mode === 'all'
      ? 'whole application'
      : `${report.scope.mode}: ${((report.scope.mode === 'domains' ? report.scope.domains : report.scope.entities) ?? []).join(', ')}`;
  const dataModelSection =
    report.dataModel && erMermaid
      ? `<section>
  <h2>Scoped Data Model</h2>
  <p class="hint">${report.dataModel.entities.length} entities in scope (${escapeHtml(scopeLabel)})${
    report.dataModel.source ? ` · source: <code>${escapeHtml(report.dataModel.source)}</code>` : ''
  }</p>
  <div class="card diagram"><pre class="mermaid">${escapeHtml(erMermaid)}</pre></div>
</section>`
      : '';

  const mermaid = buildHierarchyMermaid(report);
  const fallbackTree = analysis ? renderHierarchyTree(analysis.proposal.resourceTypes).join('\n') : '';
  const diagramSection = mermaid
    ? `<section>
  <h2>Proposed Resource Hierarchy</h2>
  <p class="hint">Roles cascade downward: a role assigned on a parent resource applies to all of its descendants.</p>
  <div class="card diagram"><pre class="mermaid">${escapeHtml(mermaid)}</pre></div>
  <noscript><pre class="tree">${escapeHtml(fallbackTree)}</pre></noscript>
</section>`
    : '';

  const resourceTypesSection =
    analysis && analysis.proposal.resourceTypes.length > 0
      ? `<section><h2>Resource Types</h2>${analysis.proposal.resourceTypes
          .map(
            (rt) => `<div class="card">
  <h3>${escapeHtml(rt.displayName)} <code>${escapeHtml(rt.type)}</code></h3>
  <p class="meta">${rt.parent ? `Parent: <code>${escapeHtml(rt.parent)}</code>` : 'Root resource'}${
    rt.mappedEntities.length > 0 ? ` · Maps to: ${rt.mappedEntities.map((e) => `<code>${escapeHtml(e)}</code>`).join(', ')}` : ''
  }</p>
  <p>${escapeHtml(rt.rationale)}</p>
</div>`,
          )
          .join('\n')}</section>`
      : '';

  const rolesSection =
    analysis && analysis.proposal.roles.length > 0
      ? `<section><h2>Roles &amp; Permissions</h2><table>
  <thead><tr><th>Role</th><th>Scoped to</th><th>Permissions</th><th>Cascades</th></tr></thead>
  <tbody>${analysis.proposal.roles
    .map(
      (role) =>
        `<tr><td><strong>${escapeHtml(role.name)}</strong></td><td><code>${escapeHtml(role.resourceType)}</code></td><td>${role.permissions
          .map((p) => `<code>${escapeHtml(p)}</code>`)
          .join(' ')}</td><td>${role.cascades ? 'Yes' : 'No'}</td></tr>`,
    )
    .join('')}</tbody>
</table></section>`
      : '';

  const checksSection =
    analysis && analysis.proposal.exampleChecks.length > 0
      ? `<section><h2>Example Access Checks</h2>${analysis.proposal.exampleChecks
          .map(
            (check) => `<div class="card check">
  <span class="badge ${check.expected ? 'allow' : 'deny'}">${check.expected ? 'ALLOW' : 'DENY'}</span>
  <strong>${escapeHtml(check.description)}</strong>
  <p class="mono">check(<code>${escapeHtml(check.subject)}</code>, <code>${escapeHtml(check.permission)}</code>, <code>${escapeHtml(check.resource)}</code>)</p>
  ${check.path ? `<p class="meta">${escapeHtml(check.path)}</p>` : ''}
</div>`,
          )
          .join('\n')}</section>`
      : '';

  const recommendationsSection =
    analysis && analysis.recommendations.length > 0
      ? `<section><h2>Recommendations</h2>${analysis.recommendations
          .map(
            (rec) => `<div class="card">
  <span class="badge priority-${rec.priority}">${rec.priority.toUpperCase()}</span>
  <strong>${escapeHtml(rec.title)}</strong>
  <p>${escapeHtml(rec.detail)}</p>
</div>`,
          )
          .join('\n')}</section>`
      : '';

  const warningsSection =
    analysis && analysis.warnings.length > 0
      ? `<section><h2>Warnings</h2><ul>${analysis.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></section>`
      : '';

  const emptyState = !analysis
    ? `<section><div class="card"><p>${escapeHtml(report.skipReason ?? 'No analysis was produced for this project.')}</p></div></section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WorkOS FGA Scan — ${project}</title>
<style>
  :root { --accent: #6363f1; --ink: #1a1a2e; --muted: #6b7280; --border: #e5e7eb; --bg: #fafafa; }
  * { box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--ink); background: var(--bg); margin: 0; line-height: 1.6; }
  main { max-width: 880px; margin: 0 auto; padding: 48px 24px 96px; }
  header { border-bottom: 1px solid var(--border); padding-bottom: 24px; margin-bottom: 32px; }
  header h1 { margin: 0 0 4px; font-size: 28px; }
  header .meta { color: var(--muted); font-size: 14px; }
  h2 { font-size: 20px; margin: 40px 0 12px; }
  h3 { font-size: 16px; margin: 0 0 4px; }
  p { margin: 8px 0; }
  .hint, .meta { color: var(--muted); font-size: 14px; }
  code { background: #eef0ff; color: #3f3fd1; border-radius: 4px; padding: 1px 6px; font-size: 13px; font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
  .card { background: #fff; border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; margin: 12px 0; }
  .card.diagram { display: flex; justify-content: center; padding: 24px; }
  .mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 13px; }
  .tree { background: #fff; border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 14px; vertical-align: top; }
  th { background: #f4f4f8; font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; border-radius: 999px; padding: 2px 10px; margin-right: 8px; }
  .badge.allow { background: #dcfce7; color: #15803d; }
  .badge.deny { background: #fee2e2; color: #b91c1c; }
  .badge.priority-high { background: #fee2e2; color: #b91c1c; }
  .badge.priority-medium { background: #fef9c3; color: #a16207; }
  .badge.priority-low { background: #f3f4f6; color: #6b7280; }
  footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
  footer a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <header>
    <h1>FGA Modeling Proposal</h1>
    <div class="meta">${project} · generated ${escapeHtml(report.timestamp)} · WorkOS CLI scan v${escapeHtml(report.version)}</div>
  </header>
  ${emptyState}
  ${summarySection}
  ${dataModelSection}
  ${diagramSection}
  ${resourceTypesSection}
  ${rolesSection}
  ${checksSection}
  ${recommendationsSection}
  ${warningsSection}
  <footer>
    Generated by <code>workos scan fga</code>. This proposal is AI-generated — review it against your
    requirements before implementing. Learn more at <a href="${FGA_DOCS_URL}">${FGA_DOCS_URL}</a>.
  </footer>
</main>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'strict' });
</script>
</body>
</html>`;
}
