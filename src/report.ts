import type { AuditConfig, Impact, IssueGroup, PageResult, Report, ScoreBreakdown } from './types.ts';
import { SCHEMA_VERSION } from './types.ts';
import { buildGroups } from './group.ts';
import { rawSiteOverall, round, SCORING_VERSION, scorePage, scoreSite } from './score.ts';

const IMPACT_ORDER: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

export function buildReport(
  config: AuditConfig,
  pages: PageResult[],
  meta: { version: string; axeVersion: string; browser: string },
): Report {
  for (const p of pages) if (p.status === 'ok') p.score = scorePage(p);

  const score = scoreSite(pages);
  const base = rawSiteOverall(pages);
  const issues = buildGroups(pages, (p) => p.violations);
  for (const g of issues) {
    g.estimatedScoreGain = g.scored ? round(rawSiteOverall(pages, g.id) - base, 2) : 0;
  }
  issues.sort(
    (a, b) =>
      b.estimatedScoreGain - a.estimatedScoreGain ||
      (IMPACT_ORDER[a.impact ?? 'moderate'] - IMPACT_ORDER[b.impact ?? 'moderate']) ||
      b.occurrences - a.occurrences,
  );
  const needsReview = buildGroups(pages, (p) => p.incomplete).sort(
    (a, b) => (IMPACT_ORDER[a.impact ?? 'moderate'] - IMPACT_ORDER[b.impact ?? 'moderate']) || b.occurrences - a.occurrences,
  );

  const byImpact: Record<Impact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const g of issues) byImpact[g.impact ?? 'moderate'] += g.occurrences;

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'daredevil', version: meta.version, axeVersion: meta.axeVersion, scoringVersion: SCORING_VERSION, browser: meta.browser },
    generatedAt: new Date().toISOString(),
    config,
    summary: {
      score,
      pagesScanned: pages.filter((p) => p.status === 'ok').length,
      pagesFailed: pages.filter((p) => p.status === 'error').length,
      violations: { groups: issues.length, nodes: issues.reduce((a, g) => a + g.occurrences, 0), byImpact },
      needsReview: { groups: needsReview.length, nodes: needsReview.reduce((a, g) => a + g.occurrences, 0) },
    },
    issues,
    needsReview,
    pages,
  };
}

// ---------------------------------------------------------------- diff

export interface ReportDiff {
  comparable: boolean;
  warnings: string[];
  overall: { before: number; after: number; delta: number };
  breakdown: { key: string; before: number; after: number; delta: number }[];
  fixed: IssueGroup[];
  introduced: IssueGroup[];
  changed: { group: IssueGroup; before: number; after: number }[];
  pages: { path: string; before?: number; after?: number }[];
}

export function diffReports(a: Report, b: Report): ReportDiff {
  const warnings: string[] = [];
  if (a.tool.scoringVersion !== b.tool.scoringVersion) warnings.push(`scoring version differs (${a.tool.scoringVersion} → ${b.tool.scoringVersion}): scores are not comparable`);
  if (a.tool.axeVersion !== b.tool.axeVersion) warnings.push(`axe-core version differs (${a.tool.axeVersion} → ${b.tool.axeVersion}): rule set may differ`);
  const pathsA = new Set(a.pages.filter((p) => p.status === 'ok').map((p) => p.path));
  const pathsB = new Set(b.pages.filter((p) => p.status === 'ok').map((p) => p.path));
  const onlyA = [...pathsA].filter((p) => !pathsB.has(p));
  const onlyB = [...pathsB].filter((p) => !pathsA.has(p));
  if (onlyA.length || onlyB.length) {
    warnings.push(`page sets differ (${onlyA.length} only in before, ${onlyB.length} only in after); re-run with --same-pages for a strict comparison`);
  }

  const flat = (s: ScoreBreakdown) => ({
    overall: s.overall,
    'level A': s.byLevel.A,
    'level AA': s.byLevel.AA,
    ...s.byPrinciple,
    'best-practice': s.bestPractice,
  });
  const fa = flat(a.summary.score) as Record<string, number>;
  const fb = flat(b.summary.score) as Record<string, number>;
  const breakdown = Object.keys(fa).map((key) => ({ key, before: fa[key], after: fb[key], delta: round(fb[key] - fa[key]) }));

  const ga = new Map(a.issues.map((g) => [g.id, g]));
  const gb = new Map(b.issues.map((g) => [g.id, g]));
  const fixed = a.issues.filter((g) => !gb.has(g.id));
  const introduced = b.issues.filter((g) => !ga.has(g.id));
  const changed = b.issues
    .filter((g) => ga.has(g.id) && ga.get(g.id)!.occurrences !== g.occurrences)
    .map((g) => ({ group: g, before: ga.get(g.id)!.occurrences, after: g.occurrences }));

  const allPaths = [...new Set([...pathsA, ...pathsB])].sort();
  const sa = new Map(a.pages.map((p) => [p.path, p.score?.overall]));
  const sb = new Map(b.pages.map((p) => [p.path, p.score?.overall]));
  const pages = allPaths.map((path) => ({ path, before: sa.get(path), after: sb.get(path) }));

  return {
    comparable: warnings.length === 0,
    warnings,
    overall: { before: a.summary.score.overall, after: b.summary.score.overall, delta: round(b.summary.score.overall - a.summary.score.overall) },
    breakdown,
    fixed,
    introduced,
    changed,
    pages,
  };
}

// ---------------------------------------------------------------- markdown

const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s: string) => '`' + s.replace(/`/g, "'").replace(/\n/g, ' ') + '`';

export function diffMarkdown(d: ReportDiff): string {
  const out: string[] = [];
  out.push(`**Overall: ${d.overall.before} → ${d.overall.after} (${sign(d.overall.delta)})**`, '');
  for (const w of d.warnings) out.push(`> ⚠️ ${w}`);
  if (d.warnings.length) out.push('');
  out.push('| Score | Before | After | Δ |', '|---|---:|---:|---:|');
  for (const r of d.breakdown) out.push(`| ${r.key} | ${r.before} | ${r.after} | ${sign(r.delta)} |`);
  out.push('', `Issue groups: **${d.fixed.length} fixed**, **${d.introduced.length} new**, ${d.changed.length} changed in size.`, '');
  if (d.fixed.length) {
    out.push('Fixed:');
    for (const g of d.fixed) out.push(`- ✅ \`${g.ruleId}\` ${esc(g.signature)} (${g.occurrences} nodes)`);
    out.push('');
  }
  if (d.introduced.length) {
    out.push('New:');
    for (const g of d.introduced) out.push(`- ❌ \`${g.ruleId}\` ${esc(g.signature)} (${g.occurrences} nodes, ${g.impact})`);
    out.push('');
  }
  if (d.changed.length) {
    out.push('Changed:');
    for (const c of d.changed) out.push(`- \`${c.group.ruleId}\` ${esc(c.group.signature)}: ${c.before} → ${c.after} nodes`);
    out.push('');
  }
  return out.join('\n');
}

export function reportMarkdown(r: Report, diff?: ReportDiff): string {
  const s = r.summary;
  const out: string[] = [];
  out.push(`# Accessibility report: ${r.config.startUrl}`, '');
  out.push(
    `Generated ${r.generatedAt} by daredevil ${r.tool.version} (axe-core ${r.tool.axeVersion}, scoring v${r.tool.scoringVersion}, ${r.tool.browser}).`,
    `Scope: \`${r.config.scope.origin}${r.config.scope.pathPrefix || '/'}\`, ${s.pagesScanned} pages scanned${s.pagesFailed ? `, ${s.pagesFailed} failed` : ''}.`,
    '',
  );
  out.push(`## Score: ${s.score.overall} / 100`, '');
  out.push('| Dimension | Score |', '|---|---:|');
  out.push(`| **Overall (WCAG A+AA)** | **${s.score.overall}** |`);
  out.push(`| Level A | ${s.score.byLevel.A} |`, `| Level AA | ${s.score.byLevel.AA} |`);
  for (const [k, v] of Object.entries(s.score.byPrinciple)) out.push(`| ${k[0].toUpperCase() + k.slice(1)} | ${v} |`);
  out.push(`| Best practices (not in overall) | ${s.score.bestPractice} |`, '');
  out.push(
    `Violations: **${s.violations.nodes} nodes in ${s.violations.groups} root-cause groups** ` +
      `(critical ${s.violations.byImpact.critical}, serious ${s.violations.byImpact.serious}, moderate ${s.violations.byImpact.moderate}, minor ${s.violations.byImpact.minor}). ` +
      `Needs review: ${s.needsReview.nodes} nodes in ${s.needsReview.groups} groups.`,
    '',
  );

  if (diff) out.push('## Change since previous run', '', diffMarkdown(diff));

  out.push('## Issues by priority', '', 'Sorted by estimated score gain if fixed. Each group is one likely root cause.', '');
  out.push('| # | Gain | Impact | Rule | WCAG | Root cause | Nodes | Pages |', '|---:|---:|---|---|---|---|---:|---:|');
  r.issues.forEach((g, i) => {
    out.push(
      `| ${i + 1} | ${g.scored ? sign(g.estimatedScoreGain) : 'n/a'} | ${g.impact ?? '?'} | [${g.ruleId}](${g.helpUrl}) | ${g.wcag.join(', ') || 'best practice'} ${g.level !== 'none' ? `(${g.level})` : ''} | ${code(g.signature)} | ${g.occurrences} | ${g.pageCount} |`,
    );
  });
  out.push('');

  out.push('## Issue details', '');
  r.issues.forEach((g, i) => {
    out.push(`### ${i + 1}. ${esc(g.help)} — \`${g.ruleId}\` [${g.id}]`, '');
    out.push(`- Impact: **${g.impact}** · WCAG ${g.wcag.join(', ') || 'n/a'} ${g.level !== 'none' ? `(${g.level})` : '(best practice)'} · ${g.principle}`);
    out.push(`- Root cause: ${code(g.signature)} · ${g.occurrences} nodes on ${g.pageCount} page(s)`);
    out.push(`- Where: ${g.patterns.slice(0, 6).map(code).join(', ')}${g.patterns.length > 6 ? ` +${g.patterns.length - 6} more patterns` : ''}`);
    out.push(`- Pages: ${g.pages.slice(0, 8).map(code).join(', ')}${g.pages.length > 8 ? ` +${g.pages.length - 8} more` : ''}`);
    out.push(`- Reference: ${g.helpUrl}`, '');
    for (const ex of g.examples.slice(0, 3)) {
      out.push(`  - ${code(ex.page)} ${code(ex.selector)}`);
      out.push('    ```html', `    ${ex.html.replace(/\n/g, ' ')}`, '    ```');
    }
    if (g.examples[0]?.failureSummary) out.push('', '  ' + g.examples[0].failureSummary.replace(/\n\s*/g, ' / '));
    out.push('');
  });

  if (r.needsReview.length) {
    out.push('## Needs review (not scored)', '', 'axe could not decide these automatically.', '');
    for (const g of r.needsReview) out.push(`- \`${g.ruleId}\` ${esc(g.help)}: ${code(g.signature)} (${g.occurrences} nodes, ${g.pageCount} pages)`);
    out.push('');
  }

  const kb = r.pages.filter((p) => p.keyboard);
  if (kb.length) {
    out.push('## Keyboard probe (heuristic, not scored)', '');
    out.push('| Page | Tab stops / tabbable | Skip link | No visible focus | Possible trap |', '|---|---:|---|---:|---|');
    for (const p of kb) {
      const k = p.keyboard!;
      out.push(`| ${code(p.path)} | ${k.tabStops} / ${k.tabbableElements} | ${k.hasSkipLink ? 'yes' : 'no'} | ${k.noVisibleFocus.length} | ${k.possibleTrap ? code(k.possibleTrap) : ''} |`);
    }
    out.push('');
  }

  out.push('## Pages', '', '| Page | Score | Violations (nodes) | Status |', '|---|---:|---:|---|');
  for (const p of r.pages) {
    const nodes = p.violations.reduce((a, v) => a + v.nodes.length, 0);
    out.push(`| ${code(p.path)} | ${p.score?.overall ?? ''} | ${p.status === 'ok' ? nodes : ''} | ${p.status}${p.error ? `: ${esc(p.error)}` : ''} |`);
  }
  out.push('');
  return out.join('\n');
}
