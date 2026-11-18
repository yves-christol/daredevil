import type { Impact, IssueGroup, PageResult, Report } from './types.ts';
import type { ReportDiff } from './report.ts';
import { MAX_TABS as MAX_TABS_LABEL } from './probes.ts';

/** Agent finding as written in assisted.json. */
export interface AssistedFinding {
  id: string;
  category: string;
  wcag?: string[];
  impact?: Impact;
  confidence?: 'high' | 'medium' | 'low';
  page?: string;
  selector?: string;
  evidence: string;
  recommendation: string;
}

export interface HtmlExtras {
  diff?: ReportDiff;
  assisted?: { findings: AssistedFinding[]; notes?: unknown };
  summaryMd?: string;
  hasHandoff?: boolean;
}

// ------------------------------------------------------------------ helpers
// Everything coming from the audited site (HTML snippets, selectors, alt text, titles)
// is untrusted: always go through esc(). Hrefs go through safeHref().

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const safeHref = (u: string): string => (/^https?:\/\//i.test(u) ? esc(u) : '#');
const assetHref = (p: string): string => (/^assets\/[\w.-]+$/.test(p) ? esc(p) : '');

const fmt = (n: number) => n.toLocaleString('en-US');
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

type Band = 'good' | 'fair' | 'poor' | 'bad';
function band(score: number): Band {
  return score >= 90 ? 'good' : score >= 75 ? 'fair' : score >= 50 ? 'poor' : 'bad';
}
const BAND_LABEL: Record<Band, string> = { good: 'Good', fair: 'Fair', poor: 'Poor', bad: 'Critical' };

const impactBadge = (i: Impact | null | undefined) => {
  const v = i ?? 'moderate';
  return `<span class="badge impact-${v}">${v}</span>`;
};

function ring(score: number, size = 168): string {
  const r = 70;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  const b = band(score);
  return `<svg class="ring band-${b}" width="${size}" height="${size}" viewBox="0 0 160 160" role="img" aria-label="Score ${score} out of 100, ${BAND_LABEL[b]}">
  <circle cx="80" cy="80" r="${r}" class="ring-track"/>
  <circle cx="80" cy="80" r="${r}" class="ring-value" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 80 80)"/>
  <text x="80" y="78" text-anchor="middle" class="ring-num">${score}</text>
  <text x="80" y="104" text-anchor="middle" class="ring-sub">/ 100</text>
</svg>`;
}

function meter(label: string, score: number, note = ''): string {
  const b = band(score);
  return `<div class="meter">
  <div class="meter-head"><span>${esc(label)}${note ? ` <small>${esc(note)}</small>` : ''}</span><strong>${score}</strong></div>
  <div class="meter-bar" aria-hidden="true"><span class="band-${b}" style="width:${Math.max(0, Math.min(100, score))}%"></span></div>
</div>`;
}

/** Minimal Markdown → HTML for agent-written summaries: headings, lists, tables, emphasis, code, links. */
export function markdownToHtml(md: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const lines = md.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      // Shift headings so a summary's "# Title" nests under the report's own h2.
      const level = Math.min(6, h[1].length + 2);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      // Lists, with nesting by indentation.
      const stack: { indent: number; tag: string }[] = [];
      let html = '';
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i])!;
        const indent = m[1].length;
        const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        while (stack.length && indent < stack[stack.length - 1].indent) html += `</li></${stack.pop()!.tag}>`;
        if (!stack.length || indent > stack[stack.length - 1].indent) {
          html += `<${tag}>`;
          stack.push({ indent, tag });
        } else html += '</li>';
        html += `<li>${inline(m[3])}`;
        i++;
      }
      while (stack.length) html += `</li></${stack.pop()!.tag}>`;
      out.push(html);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ sections

function issueCard(g: IssueGroup, rank: number, maxGain: number): string {
  const gainPct = maxGain > 0 ? Math.max(2, (g.estimatedScoreGain / maxGain) * 100) : 0;
  const ex = g.examples.slice(0, 3);
  return `<li class="issue" data-impact="${esc(g.impact ?? 'moderate')}">
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
    <div class="finding-head">${impactBadge(f.impact)} <span class="badge conf-${esc(f.confidence ?? 'medium')}">${esc(f.confidence ?? 'medium')} confidence</span> <span class="muted">${esc(f.id)} · ${esc(f.category)}${f.wcag?.length ? ` · WCAG ${esc(f.wcag.join(', '))}` : ''}</span></div>
    ${f.page || f.selector ? `<p class="where">${f.page ? `<code>${esc(f.page)}</code>` : ''} ${f.selector ? `<code class="sel">${esc(f.selector)}</code>` : ''}</p>` : ''}
    <p><strong>Evidence.</strong> ${esc(f.evidence)}</p>
    <p><strong>Recommendation.</strong> ${esc(f.recommendation)}</p>
  </li>`,
    )
    .join('')}
  </ul>
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
    <div><h3>Fixed <span class="count">${d.fixed.length}</span></h3><ul class="plain">${d.fixed.map((g) => `<li>✓ <code>${esc(g.ruleId)}</code> ${esc(g.signature)} <span class="muted">(${g.occurrences})</span></li>`).join('') || '<li class="muted">none</li>'}</ul></div>
    <div><h3>New <span class="count">${d.introduced.length}</span></h3><ul class="plain">${d.introduced.map((g) => `<li>✗ <code>${esc(g.ruleId)}</code> ${esc(g.signature)} <span class="muted">(${g.occurrences})</span></li>`).join('') || '<li class="muted">none</li>'}</ul></div>
    <div><h3>Changed <span class="count">${d.changed.length}</span></h3><ul class="plain">${d.changed.map((c) => `<li><code>${esc(c.group.ruleId)}</code> ${esc(c.group.signature)} <span class="muted">${c.before} → ${c.after}</span></li>`).join('') || '<li class="muted">none</li>'}</ul></div>
  </div>
</section>`;
}

function imagesSection(pages: PageResult[]): string {
  const imgs = pages.flatMap((p) => (p.images ?? []).filter((i) => i.screenshot).map((i) => ({ ...i, page: p.path })));
  if (!imgs.length) return '';
  const shown = imgs.slice(0, 60);
  return `<section id="images" aria-labelledby="images-h">
  <h2 id="images-h">Images and their alt text <span class="count">${imgs.length}</span></h2>
  <p class="lede">Does each text alternative convey what the image conveys? Screenshots taken during the scan${imgs.length > shown.length ? `; first ${shown.length} shown` : ''}.</p>
  <ul class="gallery">
  ${shown
    .map(
      (i) => `<li><figure>
    <div class="thumb"><img src="${assetHref(i.screenshot!)}" alt="" loading="lazy"></div>
    <figcaption><span class="alt-label">alt</span> “${esc(i.alt)}”<br><code>${esc(i.page)}</code></figcaption>
  </figure></li>`,
    )
    .join('')}
  </ul>
</section>`;
}

// ------------------------------------------------------------------ page

export function renderHtml(r: Report, extras: HtmlExtras = {}): string {
  const s = r.summary;
  const scopeLabel = r.config.scope.origin.replace(/^https?:\/\//, '') + r.config.scope.pathPrefix;
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
    r.needsReview.length && ['review', 'Needs review'],
    kb.length && ['keyboard', 'Keyboard'],
    r.pages.some((p) => p.images?.some((i) => i.screenshot)) && ['images', 'Images'],
    ['pages', 'Pages'],
    ['method', 'Method'],
  ].filter(Boolean) as [string, string][];

  const impacts: Impact[] = ['critical', 'serious', 'moderate', 'minor'];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accessibility report: ${esc(scopeLabel)}</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap top-inner">
    <p class="brand"><span aria-hidden="true">◉</span> daredevil <span class="muted">accessibility report</span></p>
    <nav aria-label="Report sections"><ul>${nav.map(([id, label]) => `<li><a href="#${id}">${label}</a></li>`).join('')}</ul></nav>
  </div>
</header>

<main id="main" class="wrap">
<section class="hero" aria-labelledby="title">
  <div class="hero-text">
    <h1 id="title">${esc(scopeLabel)}</h1>
    <p class="muted">${dateLabel} · ${s.pagesScanned} page${s.pagesScanned === 1 ? '' : 's'} scanned${s.pagesFailed ? ` · <strong>${s.pagesFailed} failed</strong>` : ''}${consentPages ? ` · cookie dialog dismissed on ${consentPages} page${consentPages === 1 ? '' : 's'}` : ''}</p>
    <ul class="stats">
      <li><strong>${fmt(s.violations.nodes)}</strong><span>failing elements</span></li>
      <li><strong>${s.violations.groups}</strong><span>root causes</span></li>
      <li><strong>${fmt(s.violations.byImpact.critical)}</strong><span>critical</span></li>
      <li><strong>${fmt(s.needsReview.nodes)}</strong><span>to review</span></li>
    </ul>
    ${extras.hasHandoff ? '<p class="handoff">A fix plan for an AI agent is in <code>handoff.md</code>, next to this file.</p>' : ''}
  </div>
  <div class="hero-score">
    ${ring(s.score.overall)}
    <p class="band-label band-text-${band(s.score.overall)}">${BAND_LABEL[band(s.score.overall)]}</p>
    <p class="muted small">WCAG 2.2 A + AA${extras.diff ? ` · ${signed(extras.diff.overall.delta)} since last run` : ''}</p>
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
  <p class="lede">Each entry is one likely root cause, ranked by the score points gained if it is fixed. Open an entry for locations and evidence.</p>
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

${r.needsReview.length ? `<section id="review" aria-labelledby="review-h">
  <h2 id="review-h">Needs review <span class="count">${r.needsReview.length}</span></h2>
  <p class="lede">axe could not decide these automatically (for example text over images). Not scored.</p>
  <details class="card"><summary>Show ${r.needsReview.length} groups (${fmt(s.needsReview.nodes)} elements)</summary>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col">Rule</th><th scope="col">Check</th><th scope="col">Root cause</th><th scope="col" class="num">Elements</th><th scope="col" class="num">Pages</th></tr></thead>
    <tbody>${r.needsReview.map((g) => `<tr><td><code>${esc(g.ruleId)}</code></td><td>${esc(g.help)}</td><td><code>${esc(g.signature)}</code></td><td class="num">${g.occurrences}</td><td class="num">${g.pageCount}</td></tr>`).join('')}</tbody>
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
  <p><strong>Scoring v${esc(r.tool.scoringVersion)}.</strong> Each failing rule costs <code>weight × (1 + log2(failing elements))</code> with weights critical 10, serious 5, moderate 2, minor 1. A page scores <code>100 × exp(−penalty / 100)</code>, and the site score is the mean over pages. Best-practice rules and undecided results are excluded from the overall score. Scores are comparable only with the same scoring and axe-core versions.</p>
  <p><strong>Limits.</strong> Automated rules find only part of WCAG failures. A high score means few detectable violations, not conformance: manual testing with a keyboard and screen readers is still required.</p>
  <p class="muted small">daredevil ${esc(r.tool.version)} · ${esc(r.tool.browser)} · report schema ${esc(r.schemaVersion)} · data: <code>report.json</code></p>
</section>
</main>

<script>${JS}</script>
</body>
</html>
`;
}

// ------------------------------------------------------------------ assets

const JS = `
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
:root {
  color-scheme: light;
  --bg: #f6f7f9; --surface: #ffffff; --surface-2: #eef0f4; --text: #16181d; --muted: #545b69;
  --border: #d9dde4; --accent: #3b3fd8; --accent-text: #2f33b8; --code-bg: #f1f3f7;
  --bad: #c42b1c; --poor: #c25400; --fair: #8a6d00; --good: #1a7f37;
  --bad-bg: #fde8e6; --poor-bg: #fff0e0; --fair-bg: #fbf3cf; --good-bg: #e3f4e8; --minor-bg: #e9edf3;
  --ring-track: #e4e7ec; --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0f1115; --surface: #171a21; --surface-2: #1f232c; --text: #e8eaee; --muted: #a3aab8;
    --border: #2c313c; --accent: #8b8ff5; --accent-text: #a9acff; --code-bg: #1d2129;
    --bad: #ff8a80; --poor: #ffab5e; --fair: #e8cc5a; --good: #6fd38a;
    --bad-bg: #3a1d1b; --poor-bg: #3a2614; --fair-bg: #332c10; --good-bg: #16301e; --minor-bg: #242a35;
    --ring-track: #2a2f3a; --shadow: none;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0f1115; --surface: #171a21; --surface-2: #1f232c; --text: #e8eaee; --muted: #a3aab8;
  --border: #2c313c; --accent: #8b8ff5; --accent-text: #a9acff; --code-bg: #1d2129;
  --bad: #ff8a80; --poor: #ffab5e; --fair: #e8cc5a; --good: #6fd38a;
  --bad-bg: #3a1d1b; --poor-bg: #3a2614; --fair-bg: #332c10; --good-bg: #16301e; --minor-bg: #242a35;
  --ring-track: #2a2f3a; --shadow: none;
}
* { box-sizing: border-box; }
html { scroll-padding-top: 4.5rem; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 0 16px; }
a { color: var(--accent-text); }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .86em; }
code { background: var(--code-bg); padding: .1em .35em; border-radius: 4px; overflow-wrap: anywhere; }
pre { background: var(--code-bg); padding: .75rem 1rem; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
pre code { background: none; padding: 0; }
.muted { color: var(--muted); }
.small { font-size: .875rem; }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.skip { position: absolute; left: 16px; top: -100px; background: var(--accent); color: #fff; padding: .5rem 1rem; border-radius: 6px; z-index: 10; }
.skip:focus { top: 8px; }

.top { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
.top-inner { display: flex; align-items: center; gap: 1.5rem; min-height: 3.5rem; flex-wrap: wrap; }
.brand { margin: 0; font-weight: 700; letter-spacing: -.01em; }
.brand span[aria-hidden] { color: var(--accent); }
.top nav ul { display: flex; gap: .25rem; list-style: none; margin: 0; padding: 0; flex-wrap: wrap; }
.top nav a { display: block; padding: .3rem .6rem; border-radius: 6px; text-decoration: none; color: var(--muted); font-size: .9rem; }
.top nav a:hover { background: var(--surface-2); color: var(--text); }

section { margin: 2.5rem 0; }
h1 { font-size: clamp(1.6rem, 3.5vw, 2.3rem); line-height: 1.15; margin: 0 0 .4rem; letter-spacing: -.02em; overflow-wrap: anywhere; }
h2 { font-size: 1.4rem; margin: 0 0 .5rem; letter-spacing: -.01em; }
h3 { font-size: 1.05rem; margin: 1.2rem 0 .4rem; }
h4 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 1rem 0 .4rem; }
.lede { color: var(--muted); margin: 0 0 1rem; max-width: 70ch; }
.count { display: inline-block; font-size: .8rem; font-weight: 600; background: var(--surface-2); color: var(--muted); border-radius: 999px; padding: .1rem .55rem; vertical-align: middle; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); padding: 1.25rem 1.5rem; }

.hero { display: grid; grid-template-columns: 1.3fr auto 1fr; gap: 2rem; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); padding: 2rem; margin-top: 1.5rem; }
.hero-score { text-align: center; }
.hero-score p { margin: .2rem 0; }
.band-label { font-weight: 700; font-size: 1.1rem; }
.stats { list-style: none; padding: 0; margin: 1.25rem 0 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .75rem; }
.stats li { background: var(--surface-2); border-radius: 10px; padding: .6rem .75rem; }
.stats strong { display: block; font-size: 1.35rem; line-height: 1.2; }
.stats span { color: var(--muted); font-size: .8rem; }
.handoff { margin: 1rem 0 0; font-size: .9rem; color: var(--muted); }
.ring-track { fill: none; stroke: var(--ring-track); stroke-width: 14; }
.ring-value { fill: none; stroke-width: 14; stroke-linecap: round; }
.ring.band-bad .ring-value { stroke: var(--bad); } .ring.band-poor .ring-value { stroke: var(--poor); }
.ring.band-fair .ring-value { stroke: var(--fair); } .ring.band-good .ring-value { stroke: var(--good); }
.ring-num { font-size: 40px; font-weight: 800; fill: var(--text); letter-spacing: -1px; }
.ring-sub { font-size: 14px; fill: var(--muted); }
.band-text-bad { color: var(--bad); } .band-text-poor { color: var(--poor); } .band-text-fair { color: var(--fair); } .band-text-good { color: var(--good); }

.meter { margin: 0 0 .55rem; }
.meter-head { display: flex; justify-content: space-between; font-size: .9rem; }
.meter-head small { color: var(--muted); }
.meter-bar { height: 8px; background: var(--ring-track); border-radius: 999px; overflow: hidden; margin-top: .2rem; }
.meter-bar span { display: block; height: 100%; border-radius: 999px; }
.meter-bar .band-bad, .gain-bar span { background: var(--bad); }
.meter-bar .band-poor { background: var(--poor); } .meter-bar .band-fair { background: var(--fair); } .meter-bar .band-good { background: var(--good); }

.badge { display: inline-block; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; border-radius: 6px; padding: .12rem .45rem; vertical-align: 1px; }
.impact-critical { background: var(--bad-bg); color: var(--bad); }
.impact-serious { background: var(--poor-bg); color: var(--poor); }
.impact-moderate { background: var(--fair-bg); color: var(--fair); }
.impact-minor { background: var(--minor-bg); color: var(--muted); }
.conf-high { background: var(--good-bg); color: var(--good); }
.conf-medium { background: var(--fair-bg); color: var(--fair); }
.conf-low { background: var(--minor-bg); color: var(--muted); }
.pill { display: inline-block; min-width: 3.2rem; text-align: center; font-weight: 700; border-radius: 999px; padding: .1rem .5rem; font-size: .85rem; }
.pill.band-bad { background: var(--bad-bg); color: var(--bad); } .pill.band-poor { background: var(--poor-bg); color: var(--poor); }
.pill.band-fair { background: var(--fair-bg); color: var(--fair); } .pill.band-good { background: var(--good-bg); color: var(--good); }

.filters { display: flex; gap: .5rem; flex-wrap: wrap; margin: 0 0 1rem; }
.filters button { font: inherit; font-size: .9rem; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: .3rem .9rem; cursor: pointer; }
.filters button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
.filters button[aria-pressed="true"] .muted { color: inherit; opacity: .85; }

.issues { list-style: none; padding: 0; margin: 0; display: grid; gap: .6rem; }
.issue details { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); }
.issue details[open] { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.issue summary { list-style: none; display: grid; grid-template-columns: 2.2rem 1fr minmax(9rem, 13rem); gap: 1rem; align-items: center; padding: .9rem 1.1rem; cursor: pointer; }
.issue summary::-webkit-details-marker { display: none; }
.rank { display: grid; place-items: center; width: 2.2rem; height: 2.2rem; border-radius: 50%; background: var(--surface-2); font-weight: 700; color: var(--muted); }
.issue-main { min-width: 0; }
.issue-title { display: block; font-weight: 650; }
.issue-meta { display: block; font-size: .85rem; color: var(--muted); margin-top: .15rem; overflow-wrap: anywhere; }
.issue-nums { text-align: right; font-size: .85rem; display: grid; gap: .2rem; }
.gain strong { font-size: 1.15rem; color: var(--text); }
.gain-bar { height: 6px; background: var(--ring-track); border-radius: 999px; overflow: hidden; }
.gain-bar span { display: block; height: 100%; background: var(--accent); }
.issue-body { padding: 0 1.1rem 1.1rem 4.3rem; border-top: 1px solid var(--border); }
.chips { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .35rem; }
.example { margin: .6rem 0 1rem; }
.example figcaption { font-size: .85rem; margin-bottom: .3rem; display: flex; gap: .4rem; flex-wrap: wrap; }
.example pre { margin: 0; }
.failure { font-size: .85rem; color: var(--muted); border-left: 3px solid var(--border); padding-left: .75rem; margin: .5rem 0 0; }

.cards { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: .8rem; }
.finding p { margin: .45rem 0; font-size: .93rem; }
.finding-head { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; font-size: .85rem; }
.where { display: flex; gap: .35rem; flex-wrap: wrap; }

.table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); }
details .table-wrap { box-shadow: none; margin-top: .8rem; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { text-align: left; padding: .55rem .8rem; border-bottom: 1px solid var(--border); vertical-align: top; }
thead th { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); background: var(--surface-2); }
tbody tr:last-child > * { border-bottom: none; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
td.up, .delta.up span { color: var(--good); } td.down, .delta.down span { color: var(--bad); }
.warn-cell, .warn-text { color: var(--poor); font-weight: 600; }
.delta { font-size: 1.6rem; margin: .2rem 0 .8rem; }
.warn { background: var(--fair-bg); color: var(--text); border-radius: 8px; padding: .5rem .8rem; }
.cols3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.5rem; }
.plain { list-style: none; padding: 0; margin: 0; font-size: .9rem; display: grid; gap: .3rem; }

.gallery { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: .8rem; }
.gallery figure { margin: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; height: 100%; }
.thumb { aspect-ratio: 4 / 3; background: repeating-conic-gradient(var(--surface-2) 0 25%, var(--surface) 0 50%) 0 0 / 16px 16px; display: grid; place-items: center; }
.thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
.gallery figcaption { padding: .5rem .65rem; font-size: .82rem; overflow-wrap: anywhere; }
.alt-label { font-size: .7rem; font-weight: 700; text-transform: uppercase; color: var(--muted); }

.prose { max-width: 78ch; }
.prose.card { max-width: none; }
.prose h3, .prose h4 { text-transform: none; letter-spacing: normal; color: var(--text); font-size: 1.05rem; }
.prose li { margin: .25rem 0; }
.prose .table-wrap { box-shadow: none; margin: .8rem 0; }
details.card > summary { cursor: pointer; font-weight: 600; }

@media (max-width: 900px) {
  .hero { grid-template-columns: 1fr; padding: 1.25rem; }
  .hero-score { order: -1; }
  .cols3 { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .issue summary { grid-template-columns: 1fr; gap: .5rem; }
  .rank { display: none; }
  .issue-nums { text-align: left; }
  .issue-body { padding-left: 1.1rem; }
  .top nav { display: none; }
}
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
@media print {
  .top, .filters, .skip { display: none; }
  body { background: #fff; }
  .issue details > *:not(summary) { display: block; }
  .card, .hero, .issue details, .table-wrap { box-shadow: none; }
}
`;
