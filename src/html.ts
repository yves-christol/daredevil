import type { AssistedFinding, Impact, IssueGroup, PageResult, Report } from './types.ts';
export type { AssistedFinding } from './types.ts';
import type { ReportDiff } from './report.ts';
import { MAX_TABS as MAX_TABS_LABEL } from './probes.ts';
import { BAND_ICON, BAND_LABEL, CONF_ICON, band, esc, fmt, impactBadge, inline, markdownToHtml, meter, pageEnd, pageStart, ring, safeHref, signed } from './htmlkit.ts';
export { markdownToHtml } from './htmlkit.ts';
import type { FixCategory } from './fixprompt.ts';
import { explanationFor } from './explain.ts';
import { scopesLabel } from './crawl.ts';

export interface HtmlExtras {
  diff?: ReportDiff;
  assisted?: { findings: AssistedFinding[]; notes?: unknown };
  summaryMd?: string;
  hasHandoff?: boolean;
  /** AI-ready fix prompt (fix-prompt.md) and the category plan it was built from. */
  fixPrompt?: { markdown: string; plan: FixCategory[] };
}

const assetHref = (p: string): string => (/^assets\/[\w.-]+$/.test(p) ? esc(p) : '');

// ------------------------------------------------------------------ explanations
// "?" buttons open a modal <dialog> with the plain-language explanation of a rule.
// Buttons stay hidden until the script runs (no dialog support, no button).

const explainId = (ruleId: string) => `explain-${ruleId.replace(/[^\w-]/g, '_')}`;

function explainButton(ruleId: string, inlineStyle = false): string {
  const e = explanationFor(ruleId);
  if (!e) return '';
  return `<button type="button" class="explain-btn${inlineStyle ? ' inline' : ''}" data-explain="${explainId(ruleId)}" aria-haspopup="dialog" hidden><span class="visually-hidden">Explain “${esc(e.title)}”</span><span aria-hidden="true">?</span></button>`;
}

function explainDialog(ruleId: string): string {
  const e = explanationFor(ruleId);
  if (!e) return '';
  const id = explainId(ruleId);
  const list = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []);
  const affects = list(e.affects);
  const fix = list(e.fix);
  return `<dialog class="explain" id="${id}" aria-labelledby="${id}-h">
<div class="explain-inner">
  <div class="explain-head">
    <div><p class="explain-kicker">Accessibility 101 · <code>${esc(ruleId)}</code></p>
    <h2 id="${id}-h">${esc(e.title)}</h2></div>
    <button type="button" class="explain-close">Close</button>
  </div>
  <p class="explain-short">${inline(e.inShort)}</p>
  ${e.atStake ? `<h3>What is at stake</h3>\n  <p>${inline(e.atStake)}</p>` : ''}
  ${affects.length ? `<h3>Who is affected</h3><ul class="chips affects">${affects.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
  ${e.analogy ? `<p class="explain-analogy"><strong>Think of it this way.</strong> ${inline(e.analogy)}</p>` : ''}
  ${fix.length ? `<h3>How to fix it</h3><ol>${fix.map((f) => `<li>${inline(f)}</li>`).join('')}</ol>` : ''}
  ${e.bad || e.good ? `<div class="explain-code">
    ${e.bad ? `<figure><figcaption><span class="ko-icon" aria-hidden="true">✕</span> Before</figcaption><pre><code>${esc(e.bad)}</code></pre></figure>` : ''}
    ${e.good ? `<figure><figcaption><span class="ok-icon" aria-hidden="true">✓</span> After</figcaption><pre><code>${esc(e.good)}</code></pre></figure>` : ''}
  </div>` : ''}
  ${e.wcag ? `<p class="explain-wcag"><strong>The rule behind it.</strong> ${inline(e.wcag)}</p>` : ''}
</div>
</dialog>`;
}

// ------------------------------------------------------------------ sections

function issueCard(g: IssueGroup, rank: number, maxGain: number): string {
  const gainPct = maxGain > 0 ? Math.max(2, (g.estimatedScoreGain / maxGain) * 100) : 0;
  const ex = g.examples.slice(0, 3);
  const help = explainButton(g.ruleId);
  return `<li class="issue${help ? ' has-explain' : ''}" data-impact="${esc(g.impact ?? 'moderate')}">
<details>
  <summary>
    <span class="rank" aria-hidden="true">${rank}</span>
    <span class="issue-main">
      <span class="issue-title">${esc(g.help)}</span>
      <span class="issue-meta">${impactBadge(g.impact)} <code>${esc(g.ruleId)}</code> · WCAG ${esc(g.wcag.join(', ') || 'n/a')} ${g.level !== 'none' ? `(${g.level})` : '(best practice)'} · <span class="sig">${esc(g.signature)}</span></span>
    </span>
    <span class="issue-nums">
      <span class="gain">${g.scored ? `<strong>${signed(g.estimatedScoreGain)}</strong> pts` : '<span class="muted">not scored</span>'}</span>
      ${g.scored ? `<span class="gain-bar" aria-hidden="true"><span style="width:${gainPct.toFixed(1)}%"></span></span>` : ''}
      <span class="muted">${fmt(g.occurrences)} nodes · ${g.pageCount} page${g.pageCount > 1 ? 's' : ''}</span>
    </span>
  </summary>
  <div class="issue-body">
    <p>${esc(g.description)}. <a href="${safeHref(g.helpUrl)}">How to fix (Deque University)</a> · group id <code>${esc(g.id)}</code></p>
    <h4>Where</h4>
    <ul class="chips">${g.patterns.slice(0, 10).map((p) => `<li><code>${esc(p)}</code></li>`).join('')}${g.patterns.length > 10 ? `<li class="muted">+${g.patterns.length - 10} more</li>` : ''}</ul>
    <h4>Pages</h4>
    <ul class="chips">${g.pages.slice(0, 12).map((p) => `<li><code>${esc(p)}</code></li>`).join('')}${g.pages.length > 12 ? `<li class="muted">+${g.pages.length - 12} more</li>` : ''}</ul>
    <h4>Examples</h4>
    ${ex
      .map(
        (e) => `<figure class="example">
      <figcaption><code>${esc(e.page)}</code> <code class="sel">${esc(e.selector)}</code></figcaption>
      <pre><code>${esc(e.html)}</code></pre>
      ${e.failureSummary ? `<p class="failure">${esc(e.failureSummary).replace(/\n\s*/g, '<br>')}</p>` : ''}
    </figure>`,
      )
      .join('')}
  </div>
</details>
${help}
</li>`;
}

function assistedSection(findings: AssistedFinding[]): string {
  const order: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const sorted = [...findings].sort((a, b) => (order[a.impact ?? 'moderate'] ?? 2) - (order[b.impact ?? 'moderate'] ?? 2));
  return `<section id="assisted" aria-labelledby="assisted-h">
  <h2 id="assisted-h">AI-assisted findings <span class="count">${findings.length}</span></h2>
  <p class="lede">Checks that automation cannot decide (alt-text quality, keyboard behaviour, wording, undecided items), reviewed by the daredevil agent. <strong>Not part of the score.</strong> Weigh each by its confidence.</p>
  <ul class="cards">
  ${sorted
    .map(
      (f) => `<li class="card finding">
    <div class="finding-head">${impactBadge(f.impact)} <span class="badge conf-${esc(f.confidence ?? 'medium')}"><span class="icon" aria-hidden="true">${CONF_ICON[f.confidence ?? 'medium'] ?? '~'}</span>${esc(f.confidence ?? 'medium')} confidence</span> <span class="muted">${esc(f.id)} · ${esc(f.category)}${f.wcag?.length ? ` · WCAG ${esc(f.wcag.join(', '))}` : ''}</span></div>
    ${f.page || f.selector ? `<p class="where">${f.page ? `<code>${esc(f.page)}</code>` : ''} ${f.selector ? `<code class="sel">${esc(f.selector)}</code>` : ''}</p>` : ''}
    <p><strong>Evidence.</strong> ${esc(f.evidence)}</p>
    <p><strong>Recommendation.</strong> ${esc(f.recommendation)}</p>
  </li>`,
    )
    .join('')}
  </ul>
</section>`;
}

function fixPromptSection(fp: { markdown: string; plan: FixCategory[] }, hasHandoff: boolean): string {
  return `<section id="fix-prompt" aria-labelledby="fix-prompt-h">
  <h2 id="fix-prompt-h">Fix prompt for an AI agent</h2>
  <p class="lede">Paste this prompt into an AI coding agent working in the site's codebase. It lists every defect by category and asks for <strong>one merge request per category</strong>, each verified by a re-audit. Also saved as <a href="fix-prompt.md"><code>fix-prompt.md</code></a>${hasHandoff ? ', with the agent\'s <code>handoff.md</code> appended' : ''}.</p>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col" class="num">MR</th><th scope="col">Category</th><th scope="col">Branch</th><th scope="col" class="num">Groups</th><th scope="col" class="num">AI findings</th><th scope="col" class="num">Est. gain</th></tr></thead>
    <tbody>${fp.plan.map((c, i) => `<tr><td class="num">${i + 1}</td><th scope="row">${esc(c.title)}</th><td><code>${esc(c.branch)}</code></td><td class="num">${c.groups.length}</td><td class="num">${c.findings.length}${c.keyboardSignals.length ? ` <span class="muted">+${c.keyboardSignals.length} probe</span>` : ''}</td><td class="num">${c.gain > 0 ? signed(c.gain) : '0'}</td></tr>`).join('')}</tbody>
  </table></div>
  <div class="prompt-actions">
    <button type="button" class="copy-btn" id="copy-prompt" data-target="fix-prompt-text" hidden>Copy prompt</button>
    <span class="muted small" id="copy-status" role="status"></span>
  </div>
  <details class="card"><summary>Show the prompt (${fmt(fp.markdown.length)} characters)</summary>
    <pre class="prompt" id="fix-prompt-text" tabindex="0" role="region" aria-label="Fix prompt"><code>${esc(fp.markdown)}</code></pre>
  </details>
</section>`;
}

function diffSection(d: ReportDiff): string {
  const cls = d.overall.delta > 0 ? 'up' : d.overall.delta < 0 ? 'down' : 'flat';
  return `<section id="change" aria-labelledby="change-h">
  <h2 id="change-h">Change since previous run</h2>
  <p class="delta ${cls}"><strong>${d.overall.before} → ${d.overall.after}</strong> <span>(${signed(d.overall.delta)} points)</span></p>
  ${d.warnings.map((w) => `<p class="warn" role="note">⚠ ${esc(w)}</p>`).join('')}
  <div class="table-wrap"><table>
    <thead><tr><th scope="col">Score</th><th scope="col" class="num">Before</th><th scope="col" class="num">After</th><th scope="col" class="num">Δ</th></tr></thead>
    <tbody>${d.breakdown.map((r) => `<tr><th scope="row">${esc(r.key)}</th><td class="num">${r.before}</td><td class="num">${r.after}</td><td class="num ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}">${signed(r.delta)}</td></tr>`).join('')}</tbody>
  </table></div>
  <div class="cols3">
    <div><h3>Fixed <span class="count">${d.fixed.length}</span></h3><ul class="plain">${d.fixed.map((g) => `<li><span class="ok-icon" aria-hidden="true">✓</span> <code>${esc(g.ruleId)}</code>${explainButton(g.ruleId, true)} ${esc(g.signature)} <span class="muted">(${g.occurrences})</span></li>`).join('') || '<li class="muted">none</li>'}</ul></div>
    <div><h3>New <span class="count">${d.introduced.length}</span></h3><ul class="plain">${d.introduced.map((g) => `<li><span class="ko-icon" aria-hidden="true">✕</span> <code>${esc(g.ruleId)}</code>${explainButton(g.ruleId, true)} ${esc(g.signature)} <span class="muted">(${g.occurrences})</span></li>`).join('') || '<li class="muted">none</li>'}</ul></div>
    <div><h3>Changed <span class="count">${d.changed.length}</span></h3><ul class="plain">${d.changed.map((c) => `<li><code>${esc(c.group.ruleId)}</code>${explainButton(c.group.ruleId, true)} ${esc(c.group.signature)} <span class="muted">${c.before} → ${c.after}</span></li>`).join('') || '<li class="muted">none</li>'}</ul></div>
  </div>
</section>`;
}

function imagesSection(pages: PageResult[]): string {
  const imgs = pages.flatMap((p) => (p.images ?? []).map((i) => ({ ...i, page: p.path })));
  if (!imgs.length) return '';
  const shown = imgs.slice(0, 60);
  const shots = imgs.some((i) => i.screenshot);
  const how = shots ? 'Screenshots taken during the scan' : 'No screenshots (off for logged-in audits, personal data): open the image address to compare';
  return `<section id="images" aria-labelledby="images-h">
  <h2 id="images-h">Images and their alt text <span class="count">${imgs.length}</span></h2>
  <p class="lede">Does each text alternative convey what the image conveys? ${how}${imgs.length > shown.length ? `; first ${shown.length} shown` : ''}.</p>
  <ul class="gallery">
  ${shown
    .map(
      (i) => `<li><figure>
    ${i.screenshot ? `<div class="thumb"><img src="${assetHref(i.screenshot)}" alt="" loading="lazy"></div>` : ''}
    <figcaption><span class="alt-label">alt</span> “${esc(i.alt)}”<br><code>${esc(i.page)}</code>${i.screenshot ? '' : `<br><span class="alt-label">src</span> <code>${esc(i.src.startsWith('data:') ? 'inline data URL' : i.src.slice(0, 200))}</code>`}</figcaption>
  </figure></li>`,
    )
    .join('')}
  </ul>
</section>`;
}

// ------------------------------------------------------------------ page

export function renderHtml(r: Report, extras: HtmlExtras = {}): string {
  const s = r.summary;
  const scopeLabel = scopesLabel(r.config);
  const maxGain = Math.max(0, ...r.issues.map((g) => g.estimatedScoreGain));
  const kb = r.pages.filter((p) => p.keyboard);
  const consentPages = r.pages.filter((p) => p.consent?.dismissed).length;
  const findings = extras.assisted?.findings ?? [];
  const date = new Date(r.generatedAt);
  const dateLabel = isNaN(date.getTime()) ? r.generatedAt : date.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

  const nav = [
    extras.summaryMd && ['summary', 'Summary'],
    extras.diff && ['change', 'Change'],
    ['issues', 'Issues'],
    findings.length && ['assisted', 'AI findings'],
    extras.fixPrompt && ['fix-prompt', 'Fix prompt'],
    r.needsReview.length && ['review', 'Needs review'],
    kb.length && ['keyboard', 'Keyboard'],
    r.pages.some((p) => p.images?.length) && ['images', 'Images'],
    ['pages', 'Pages'],
    ['method', 'Method'],
  ].filter(Boolean) as [string, string][];

  const impacts: Impact[] = ['critical', 'serious', 'moderate', 'minor'];
  const explainedRules = [
    ...new Set([
      ...r.issues.map((g) => g.ruleId),
      ...r.needsReview.map((g) => g.ruleId),
      ...(extras.diff ? [...extras.diff.fixed, ...extras.diff.introduced, ...extras.diff.changed.map((c) => c.group)].map((g) => g.ruleId) : []),
    ]),
  ].filter((id) => explanationFor(id));

  return `${pageStart({
    title: `Accessibility report: ${scopeLabel}`,
    kicker: 'accessibility report',
    skip: { href: '#issues', label: 'Skip to violation list' },
    navLabel: 'Report sections',
    nav: nav.map(([id, label]) => [`#${id}`, label] as [string, string]),
    css: CSS,
  })}
<main id="main" class="wrap">
<section class="hero" aria-labelledby="title">
  <div class="hero-text">
    <h1 id="title">${esc(scopeLabel).replace(/\//g, '/<wbr>')}</h1>
    <p class="muted">${dateLabel} · ${s.pagesScanned} page${s.pagesScanned === 1 ? '' : 's'} scanned${s.pagesFailed ? ` · <strong>${s.pagesFailed} failed</strong>` : ''}${s.pagesAuthLost ? ` · <strong>${s.pagesAuthLost} lost the session</strong>` : ''}${consentPages ? ` · cookie dialog dismissed on ${consentPages} page${consentPages === 1 ? '' : 's'}` : ''}${r.config.auth ? ' · logged-in audit' : ''}</p>
    ${r.config.auth ? '<p class="warn" role="note">⚠ Logged-in audit: pages were scanned with a saved login session. Snippets and screenshots may contain personal data from the account. Review before sharing.</p>' : ''}
    ${s.stopped ? `<p class="warn" role="note">⚠ Crawl stopped early: ${esc(s.stopped)}</p>` : ''}
    <ul class="stats">
      <li><strong>${fmt(s.violations.nodes)}</strong><span>failing elements</span></li>
      <li><strong>${s.violations.groups}</strong><span>root causes</span></li>
      <li><strong>${fmt(s.violations.byImpact.critical)}</strong><span>critical</span></li>
      <li><strong>${fmt(s.needsReview.nodes)}</strong><span>to review</span></li>
    </ul>
    ${extras.fixPrompt ? `<p class="handoff">Ready to fix? <a href="#fix-prompt">Copy the AI fix prompt</a>: one merge request per category.</p>` : extras.hasHandoff ? '<p class="handoff">A fix plan for an AI agent is in <code>handoff.md</code>, next to this file.</p>' : ''}
  </div>
  <div class="hero-score">
    ${ring(s.score.overall)}
    <p class="band-label band-text-${band(s.score.overall)}"><span aria-hidden="true">${BAND_ICON[band(s.score.overall)]}</span> ${BAND_LABEL[band(s.score.overall)]}</p>
    <p class="muted small">WCAG 2.2 A + AA${extras.diff ? ` · ${signed(extras.diff.overall.delta)} since last run` : ''}</p>
    ${s.score.worstPages !== undefined && s.score.mean !== undefined ? `<p class="muted small">Worst ${s.score.worstPages} of ${s.pagesScanned} pages · all-page mean ${s.score.mean}</p>` : ''}
  </div>
  <div class="hero-meters">
    <h2 class="visually-hidden">Score breakdown</h2>
    ${meter('Level A', s.score.byLevel.A)}
    ${meter('Level AA', s.score.byLevel.AA)}
    ${meter('Perceivable', s.score.byPrinciple.perceivable)}
    ${meter('Operable', s.score.byPrinciple.operable)}
    ${meter('Understandable', s.score.byPrinciple.understandable)}
    ${meter('Robust', s.score.byPrinciple.robust)}
    ${meter('Best practices', s.score.bestPractice, 'not in overall')}
  </div>
</section>

${extras.summaryMd ? `<section id="summary" aria-labelledby="summary-h" class="prose card">
  <h2 id="summary-h">Summary</h2>
  ${markdownToHtml(extras.summaryMd.replace(/^#\s+.*\n/, ''))}
</section>` : ''}

${extras.diff ? diffSection(extras.diff) : ''}

<section id="issues" aria-labelledby="issues-h">
  <h2 id="issues-h">Issues by priority <span class="count">${r.issues.length}</span></h2>
  <p class="lede">Each entry is one likely root cause, ranked by the score points gained if it is fixed. Open an entry for locations and evidence.${explainedRules.length ? ' <span class="js-only" hidden>New to accessibility? Select <span class="explain-sample" aria-hidden="true">?</span> on an entry for a plain-language explanation of what is at stake and how to fix it.</span>' : ''}</p>
  <div class="filters" role="group" aria-label="Filter issues by impact">
    <button type="button" aria-pressed="true" data-filter="all">All</button>
    ${impacts.map((i) => `<button type="button" aria-pressed="false" data-filter="${i}">${i[0].toUpperCase() + i.slice(1)} <span class="muted">${r.issues.filter((g) => (g.impact ?? 'moderate') === i).length}</span></button>`).join('')}
  </div>
  <p class="visually-hidden" aria-live="polite" id="filter-status"></p>
  <ol class="issues">
    ${r.issues.map((g, i) => issueCard(g, i + 1, maxGain)).join('\n')}
  </ol>
</section>

${findings.length ? assistedSection(findings) : ''}

${extras.fixPrompt ? fixPromptSection(extras.fixPrompt, !!extras.hasHandoff) : ''}

${r.needsReview.length ? `<section id="review" aria-labelledby="review-h">
  <h2 id="review-h">Needs review <span class="count">${r.needsReview.length}</span></h2>
  <p class="lede">axe could not decide these automatically (for example text over images). Not scored.</p>
  <details class="card"><summary>Show ${r.needsReview.length} groups (${fmt(s.needsReview.nodes)} elements)</summary>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col">Rule</th><th scope="col">Check</th><th scope="col">Root cause</th><th scope="col" class="num">Elements</th><th scope="col" class="num">Pages</th></tr></thead>
    <tbody>${r.needsReview.map((g) => `<tr><td><code>${esc(g.ruleId)}</code>${explainButton(g.ruleId, true)}</td><td>${esc(g.help)}</td><td><code>${esc(g.signature)}</code></td><td class="num">${g.occurrences}</td><td class="num">${g.pageCount}</td></tr>`).join('')}</tbody>
  </table></div></details>
</section>` : ''}

${kb.length ? `<section id="keyboard" aria-labelledby="keyboard-h">
  <h2 id="keyboard-h">Keyboard probe</h2>
  <p class="lede">The engine pressed Tab through each page. A heuristic signal, not scored: a low share of reachable elements or a possible trap deserves a manual check. “${MAX_TABS_LABEL}+” means the probe stopped at its limit of ${MAX_TABS_LABEL} Tab presses, not that the rest is unreachable.</p>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col">Page</th><th scope="col" class="num">Reached / tabbable</th><th scope="col">Skip link</th><th scope="col" class="num">No visible focus</th><th scope="col">Possible trap</th></tr></thead>
    <tbody>${kb
      .map((p) => {
        const k = p.keyboard!;
        const low = !k.capped && k.tabbableElements > 10 && k.tabStops < k.tabbableElements * 0.5;
        return `<tr><td><code>${esc(p.path)}</code></td><td class="num${low ? ' warn-cell' : ''}">${k.tabStops}${k.capped ? '+' : ''} / ${k.tabbableElements}</td><td>${k.hasSkipLink ? 'yes' : '<span class="warn-text">no</span>'}</td><td class="num">${k.noVisibleFocus.length || ''}</td><td>${k.possibleTrap ? `<code>${esc(k.possibleTrap)}</code>` : ''}</td></tr>`;
      })
      .join('')}</tbody>
  </table></div>
</section>` : ''}

${imagesSection(r.pages)}

<section id="pages" aria-labelledby="pages-h">
  <h2 id="pages-h">Pages <span class="count">${r.pages.length}</span></h2>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col">Page</th><th scope="col" class="num">Score</th><th scope="col" class="num">Failing elements</th><th scope="col">Status</th></tr></thead>
    <tbody>${r.pages
      .map((p) => {
        const nodes = p.violations.reduce((a, v) => a + v.nodes.length, 0);
        const sc = p.score?.overall;
        return `<tr><td><a href="${safeHref(p.url)}"><code>${esc(p.path)}</code></a>${p.title ? `<br><span class="muted small">${esc(p.title)}</span>` : ''}</td>
        <td class="num">${sc !== undefined ? `<span class="pill band-${band(sc)}">${sc}</span>` : ''}</td>
        <td class="num">${p.status === 'ok' ? fmt(nodes) : ''}</td>
        <td>${esc(p.status)}${p.error ? `: ${esc(p.error)}` : ''}${p.probeErrors?.length ? `<br><span class="muted small">${esc(p.probeErrors.join('; '))}</span>` : ''}</td></tr>`;
      })
      .join('')}</tbody>
  </table></div>
</section>

<section id="method" aria-labelledby="method-h" class="prose">
  <h2 id="method-h">Method and limits</h2>
  <p>Each page is loaded in Chromium (${esc(r.config.viewport.width)}×${esc(r.config.viewport.height)}, reduced motion${r.config.dismissConsent ? ', cookie dialogs dismissed with "reject"' : ''}) and tested with axe-core ${esc(r.tool.axeVersion)} against WCAG 2.0, 2.1 and 2.2 level A and AA rules, plus axe best practices.</p>
  <p><strong>Scoring v${esc(r.tool.scoringVersion)}.</strong> Each failing rule costs <code>weight × (1 + log2(failing elements))</code> with weights critical 10, serious 5, moderate 2, minor 1. A page scores <code>100 × exp(−penalty / 100)</code>. ${r.summary.score.worstPages !== undefined ? `The site score is the mean of the lowest-scoring pages: the worst 10%, and at least 5 (all pages when fewer were scanned), here ${r.summary.score.worstPages} of ${r.summary.pagesScanned}. Each sub-score uses the same rule. A plain mean over all pages rises with crawl depth, as simple pages dilute the defects of the main ones; the worst pages do not. Estimated gains are measured on this score, so a fix that only touches pages outside the worst set shows little or no gain.` : 'The site score is the mean over pages.'} Best-practice rules and undecided results are excluded from the overall score. Scores are comparable only with the same scoring and axe-core versions.</p>
  <p><strong>Limits.</strong> Automated rules find only part of WCAG failures. A high score means few detectable violations, not conformance: manual testing with a keyboard and screen readers is still required.</p>
  <p class="muted small">daredevil ${esc(r.tool.version)} · ${esc(r.tool.browser)} · report schema ${esc(r.schemaVersion)} · data: <code>report.json</code></p>
</section>
</main>

${explainedRules.map(explainDialog).join('\n')}

${pageEnd(JS)}`;
}

// ------------------------------------------------------------------ assets

const JS = `
(function () {
  // Copy the fix prompt. The button stays hidden without the Clipboard API (the text remains selectable).
  var btn = document.getElementById('copy-prompt');
  var status = document.getElementById('copy-status');
  if (!btn || !navigator.clipboard) return;
  btn.hidden = false;
  btn.addEventListener('click', function () {
    var el = document.getElementById(btn.getAttribute('data-target'));
    navigator.clipboard.writeText(el ? el.textContent : '').then(
      function () { status.textContent = 'Prompt copied to the clipboard.'; },
      function () { status.textContent = 'Copy failed: open the prompt and select it manually.'; }
    );
  });
})();
(function () {
  // "?" explanations in modal dialogs. Without <dialog> support the buttons stay hidden.
  if (typeof HTMLDialogElement !== 'function') return;
  document.querySelectorAll('.js-only').forEach(function (el) { el.hidden = false; });
  document.querySelectorAll('.explain-btn').forEach(function (b) {
    var d = document.getElementById(b.getAttribute('data-explain'));
    if (!d) return;
    b.hidden = false;
    b.addEventListener('click', function () { d.showModal(); d.returnTo = b; });
  });
  document.querySelectorAll('dialog.explain').forEach(function (d) {
    d.querySelector('.explain-close').addEventListener('click', function () { d.close(); });
    // A click on the backdrop (outside the inner panel) closes the dialog.
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    d.addEventListener('close', function () { if (d.returnTo) d.returnTo.focus(); });
  });
})();
(function () {
  var buttons = document.querySelectorAll('.filters button');
  var items = document.querySelectorAll('.issues > li');
  var status = document.getElementById('filter-status');
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      var f = b.getAttribute('data-filter');
      buttons.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      var shown = 0;
      items.forEach(function (li) {
        var on = f === 'all' || li.getAttribute('data-impact') === f;
        li.hidden = !on;
        if (on) shown++;
      });
      if (status) status.textContent = shown + ' issues shown';
    });
  });
})();
`;

const CSS = `
.filters { display: flex; gap: .5rem; flex-wrap: wrap; margin: 0 0 1rem; }
.filters button { font: inherit; font-size: 14px; border: 1px solid var(--control); background: transparent; color: var(--text); border-radius: 999px; padding: .3rem .9rem; cursor: pointer; }
.filters button[aria-pressed="true"] { background: var(--focus); border-color: var(--focus); color: var(--on-focus); font-weight: 600; }
.filters button[aria-pressed="true"] .muted { color: inherit; }
.prompt-actions { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap; margin: 1rem 0 .8rem; }
.copy-btn { font: inherit; font-size: 14px; font-weight: 600; border: 1px solid var(--focus); background: var(--focus); color: var(--on-focus); border-radius: 999px; padding: .4rem 1rem; cursor: pointer; }
pre.prompt { max-height: 32rem; overflow-y: auto; margin-top: .8rem; }

.issues { list-style: none; padding: 0; margin: 0; display: grid; gap: .6rem; }
.issue details { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.issue details[open] { border: 2px solid var(--control); }
.issue summary { list-style: none; display: grid; grid-template-columns: 2.2rem 1fr minmax(9rem, 13rem); gap: 1rem; align-items: center; padding: .9rem 1.1rem; cursor: pointer; border-radius: 12px; }
.issue summary::-webkit-details-marker { display: none; }
.rank { display: grid; place-items: center; width: 2.2rem; height: 2.2rem; border-radius: 50%; border: 1px solid var(--border); font-weight: 600; color: var(--muted); font-variant-numeric: tabular-nums; }
.issue-main { min-width: 0; }
.issue-title { display: block; font-weight: 600; }
.issue-meta { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; font-size: 14px; color: var(--muted); margin-top: .25rem; overflow-wrap: anywhere; }
.issue-nums { text-align: right; font-size: 14px; display: grid; gap: .2rem; }
.gain strong { font-size: 18px; color: var(--text); font-variant-numeric: tabular-nums; }
.gain-bar { height: 6px; background: var(--ring-track); border-radius: 999px; overflow: hidden; }
.gain-bar span { display: block; height: 100%; background: var(--focus); }
.issue-body { padding: 0 1.1rem 1.1rem 4.3rem; border-top: 1px solid var(--border); }

/* "?" explanation buttons and dialogs. */
.issue { position: relative; }
.issue.has-explain summary { padding-right: 3.6rem; }
.explain-btn { position: absolute; top: 1rem; right: 1rem; width: 2rem; height: 2rem; padding: 0; display: grid; place-items: center; font: inherit; font-size: 15px; font-weight: 700; line-height: 1; color: var(--text); background: var(--surface); border: 1px solid var(--control); border-radius: 50%; cursor: pointer; }
.explain-btn.inline { position: static; display: inline-grid; vertical-align: middle; width: 1.6rem; height: 1.6rem; font-size: 13px; margin-left: .35rem; }
.explain-btn:hover { border-color: var(--text); border-width: 2px; }
.explain-btn[hidden], .js-only[hidden] { display: none; }
.explain-sample { display: inline-grid; place-items: center; width: 1.3rem; height: 1.3rem; border: 1px solid var(--control); border-radius: 50%; font-weight: 700; font-size: 12px; color: var(--text); vertical-align: 1px; }
dialog.explain { width: min(42rem, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; padding: 0; color: var(--text); background: var(--surface); border: 2px solid var(--control); border-radius: 16px; }
dialog.explain::backdrop { background: rgb(0 0 0 / .65); }
.explain-inner { padding: 1.25rem 1.5rem 1.5rem; }
.explain-inner > p, .explain-inner ol { max-width: 70ch; }
.explain-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
.explain-kicker { margin: 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.explain-kicker code { text-transform: none; letter-spacing: normal; }
.explain h2 { font-size: 20px; margin: .3rem 0 0; letter-spacing: -.01em; }
.explain h3 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 1.2rem 0 .4rem; }
.explain-short { font-size: 16px; margin: 1rem 0 0; }
.explain-close { flex: none; font: inherit; font-size: 14px; color: var(--text); background: transparent; border: 1px solid var(--control); border-radius: 999px; padding: .25rem .8rem; cursor: pointer; }
.affects li { font-size: 14px; border: 1px solid var(--border); border-radius: 999px; padding: .1rem .65rem; }
.explain-analogy { border-left: 3px solid var(--control); padding-left: .8rem; margin: 1.2rem 0 0; }
.explain ol { padding-left: 1.3rem; margin: 0; }
.explain ol li { margin: .3rem 0; }
.explain-code { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .8rem; margin-top: 1rem; }
.explain-code figure { margin: 0; }
.explain-code figcaption { font-size: 14px; font-weight: 600; margin-bottom: .3rem; }
.explain-wcag { font-size: 14px; color: var(--muted); margin: 1.2rem 0 0; }
.explain-wcag strong { color: var(--text); }
.chips { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .35rem; }

/* Offset layer cards (4px), echoing the interlocking "DD": page > element > markup. */
.example { margin: .8rem 4px 1.2rem 0; background: var(--surface); border: 1px solid var(--control); border-radius: 10px; padding: .7rem; box-shadow: 4px 4px 0 0 var(--layer); }
.example figcaption { font-size: 14px; margin-bottom: .5rem; display: flex; gap: .4rem; flex-wrap: wrap; }
.failure { font-size: 14px; color: var(--muted); border-left: 2px solid var(--border); padding-left: .75rem; margin: .6rem 0 0; }

.cards { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: .8rem; }
.finding p { margin: .45rem 0; }
.finding-head { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; font-size: 14px; }
.where { display: flex; gap: .35rem; flex-wrap: wrap; }

.gallery { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: .8rem; }
.gallery figure { margin: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; height: 100%; }
.thumb { aspect-ratio: 4 / 3; background: repeating-conic-gradient(var(--sunken) 0 25%, var(--surface) 0 50%) 0 0 / 16px 16px; display: grid; place-items: center; border-bottom: 1px solid var(--border); }
.thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
.gallery figcaption { padding: .5rem .65rem; font-size: 14px; overflow-wrap: anywhere; }
.alt-label { font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--muted); }

@media (max-width: 640px) {
  .issue summary { grid-template-columns: 1fr; gap: .5rem; }
  .rank { display: none; }
  .issue-nums { text-align: left; }
  .issue-body { padding-left: 1.1rem; }
  .explain-code { grid-template-columns: 1fr; }
  .explain-inner { padding: 1rem; }
}
@media print {
  .filters, .explain-btn { display: none; }
}
`;
