import type { BatchEntryResult, BatchReport, EntryStatus } from './batch.ts';
import { BAND_ICON, BAND_LABEL, band, esc, fmt, impactBadge, markdownToHtml, pageEnd, pageStart, safeHref, signed, type Band } from './htmlkit.ts';

/**
 * The batch page (index.html) and its markdown twin (index.md): every entry's score in one
 * sortable table, each linking to its detailed report.html. There is no combined score: each
 * entry keeps its own, and the page shows their spread.
 */

export interface BatchExtras {
  /** The agent's batch-level brief (summary.md in the batch folder). */
  summaryMd?: string;
}

const STATUS_LABEL: Record<EntryStatus, string> = {
  ok: 'Scored',
  'no-pages': 'No page scanned',
  'auth-lost': 'Session lost',
  error: 'Audit failed',
  pending: 'Not run',
};

/** Link to an entry's report, relative to the batch folder. Only plain relative paths are accepted. */
export function reportHref(e: BatchEntryResult): string | undefined {
  if (!e.reportDir || /^[a-z][\w+.-]*:/i.test(e.reportDir) || e.reportDir.startsWith('/')) return undefined;
  return encodeURI(e.reportDir.split('\\').join('/') + '/report.html');
}

const scored = (e: BatchEntryResult) => e.status === 'ok' && e.score !== undefined;

function dateLabel(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
}

/** Worst first; entries without a score last, in file order. */
export function worstFirst(entries: BatchEntryResult[]): { e: BatchEntryResult; order: number }[] {
  return entries
    .map((e, order) => ({ e, order }))
    .sort((a, b) => (scored(b.e) ? 1 : 0) - (scored(a.e) ? 1 : 0) || (a.e.score?.overall ?? 0) - (b.e.score?.overall ?? 0) || a.order - b.order);
}

function bandCounts(entries: BatchEntryResult[]): Record<Band, number> {
  const c: Record<Band, number> = { bad: 0, poor: 0, fair: 0, good: 0 };
  for (const e of entries) if (scored(e)) c[band(e.score!.overall)]++;
  return c;
}

function row({ e, order }: { e: BatchEntryResult; order: number }): string {
  const href = reportHref(e);
  const ok = scored(e);
  const s = e.score;
  const b = ok ? band(s!.overall) : undefined;
  const num = (v: number | undefined) => (v === undefined ? '' : String(v));
  const delta =
    ok && e.delta !== undefined
      ? `<td class="num ${e.delta > 0 ? 'up' : e.delta < 0 ? 'down' : ''}">${signed(e.delta)}${e.comparableWithPrevious === false ? '<br><span class="muted small">other pages</span>' : ''}</td>`
      : '<td class="num"><span class="muted">–</span></td>';
  const top = e.topIssue;
  return `<tr data-order="${order}" data-label="${esc(e.label.toLowerCase())}" data-score="${ok ? s!.overall : ''}" data-delta="${ok ? num(e.delta) : ''}" data-pages="${num(e.pagesScanned)}" data-groups="${ok ? num(e.issueGroups) : ''}" data-critical="${ok ? num(e.byImpact?.critical) : ''}">
  <th scope="row">${href ? `<a href="${esc(href)}">${esc(e.label)}</a>` : esc(e.label)}<br><span class="muted small entry-url">${esc(e.url.replace(/^https?:\/\//, ''))}${e.loggedIn ? ' · logged in' : ''}</span></th>
  <td class="num">${ok ? `<span class="pill band-${b}">${s!.overall}</span><br><span class="small band-text-${b}"><span aria-hidden="true">${BAND_ICON[b!]}</span> ${BAND_LABEL[b!]}</span>` : '<span class="muted">–</span>'}</td>
  ${delta}
  <td class="num nowrap">${ok ? `${s!.byLevel.A}<span class="muted"> / </span>${s!.byLevel.AA}` : ''}</td>
  <td class="num">${num(e.pagesScanned)}${e.pagesFailed ? `<br><span class="warn-text small">${e.pagesFailed} failed</span>` : ''}</td>
  <td class="num">${ok ? num(e.issueGroups) : ''}</td>
  <td class="num">${ok ? fmt(e.byImpact?.critical ?? 0) : ''}</td>
  <td>${ok && top ? `${esc(top.help)}<br><span class="muted small">${impactBadge(top.impact)} ${top.estimatedScoreGain > 0 ? `${signed(top.estimatedScoreGain)} pts · ` : ''}${top.pageCount} page${top.pageCount === 1 ? '' : 's'}</span>` : ''}</td>
  <td>${ok ? `<span class="ok-icon" aria-hidden="true">✓</span> ${STATUS_LABEL.ok}` : `<span class="${e.status === 'pending' ? 'muted' : 'warn-text'}"><span aria-hidden="true">${e.status === 'pending' ? '…' : '✕'}</span> ${STATUS_LABEL[e.status]}</span>`}${e.error ? `<br><span class="muted small">${esc(e.error.split('\n')[0].slice(0, 300))}</span>` : ''}${e.stopped ? `<br><span class="muted small">${esc(e.stopped)}</span>` : ''}</td>
</tr>`;
}

export function renderBatchHtml(b: BatchReport, extras: BatchExtras = {}): string {
  const s = b.summary;
  const counts = bandCounts(b.entries);
  const pending = b.entries.filter((e) => e.status === 'pending').length;
  const anyLoggedIn = b.entries.some((e) => e.loggedIn);
  const nav: [string, string][] = [
    ...(extras.summaryMd ? [['#summary', 'Summary'] as [string, string]] : []),
    ['#entries', 'Results'],
    ['#method', 'Method'],
  ];
  const stat = (v: number | undefined, label: string) => `<li><strong>${v ?? '–'}</strong><span>${label}</span></li>`;

  return `${pageStart({
    title: `Batch report: ${b.name}`,
    kicker: 'batch report',
    skip: { href: '#entries', label: 'Skip to results table' },
    nav,
    navLabel: 'Batch report sections',
    css: CSS,
  })}
<main id="main" class="wrap">
<section class="hero batch-hero" aria-labelledby="title">
  <div class="hero-text">
    <h1 id="title">${esc(b.name)}</h1>
    <p class="muted">${dateLabel(b.generatedAt)} · ${s.entries} audit${s.entries === 1 ? '' : 's'} · ${s.ok} scored${s.notOk ? ` · <strong>${s.notOk} without a score</strong>` : ''}${anyLoggedIn ? ' · includes logged-in audits' : ''}</p>
    ${!b.complete ? `<p class="warn" role="note">⚠ Batch ${pending ? `incomplete: ${pending} audit${pending === 1 ? '' : 's'} not run yet (still running, or interrupted)` : 'did not finish cleanly'}.</p>` : ''}
    ${anyLoggedIn ? '<p class="warn" role="note">⚠ Some audits ran with a saved login session. Their reports may contain personal data from the account. Review before sharing.</p>' : ''}
    <ul class="stats">
      ${stat(s.min, 'lowest score')}
      ${stat(s.median, 'median score')}
      ${stat(s.max, 'highest score')}
      ${stat(s.notOk, 'without a score')}
    </ul>
  </div>
  <div class="bands">
    <h2>Score bands</h2>
    <ul class="plain band-list">
      ${(['bad', 'poor', 'fair', 'good'] as Band[])
        .map((k) => `<li><span class="band-text-${k}"><span aria-hidden="true">${BAND_ICON[k]}</span> ${BAND_LABEL[k]}</span> <span class="muted small">${k === 'good' ? '90+' : k === 'fair' ? '75–89' : k === 'poor' ? '50–74' : 'under 50'}</span><strong>${counts[k]}</strong></li>`)
        .join('')}
    </ul>
  </div>
</section>

${extras.summaryMd ? `<section id="summary" aria-labelledby="summary-h" class="prose card">
  <h2 id="summary-h">Summary</h2>
  ${markdownToHtml(extras.summaryMd.replace(/^#\s+.*\n/, ''))}
</section>` : ''}

<section id="entries" aria-labelledby="entries-h">
  <h2 id="entries-h">Results <span class="count">${b.entries.length}</span></h2>
  <p class="lede">One row per audit, worst score first. Select an entry for its detailed report. Scores: WCAG 2.2 A + AA, mean of each audit's worst pages.<span class="js-only" hidden> Select a column heading to sort.</span></p>
  <div class="table-wrap" tabindex="0" role="region" aria-labelledby="entries-h"><table class="sortable" id="entries-table">
    <caption class="visually-hidden">Audit results, sorted by score, lowest first</caption>
    <thead><tr>
      <th scope="col" data-sort="label">Entry</th>
      <th scope="col" class="num" data-sort="score" aria-sort="ascending">Score</th>
      <th scope="col" class="num" data-sort="delta">Change</th>
      <th scope="col" class="num">A / AA</th>
      <th scope="col" class="num" data-sort="pages">Pages</th>
      <th scope="col" class="num" data-sort="groups">Root causes</th>
      <th scope="col" class="num" data-sort="critical">Critical</th>
      <th scope="col">Top issue</th>
      <th scope="col">Status</th>
    </tr></thead>
    <tbody>
    ${worstFirst(b.entries).map(row).join('\n')}
    </tbody>
  </table></div>
  <p class="visually-hidden" aria-live="polite" id="sort-status"></p>
</section>

<section id="method" aria-labelledby="method-h" class="prose">
  <h2 id="method-h">Method and limits</h2>
  <p>Each entry is a separate audit with its own crawl and score (scoring v${esc(b.tool.scoringVersion)}): the mean of that audit's lowest-scoring pages. This page does not combine them into one score. Compare entries only when they were audited with the same options; the detailed reports list the options used.</p>
  <p><strong>Change</strong> is the difference with the previous audit of the same scope. “Other pages” means the two runs did not scan the same pages: re-run with <code>samePages</code> for a strict comparison.</p>
  <p><strong>Limits.</strong> Automated rules find only part of WCAG failures. A high score means few detectable violations, not conformance.</p>
  <p class="muted small">daredevil ${esc(b.tool.version)} · batch file <code>${esc(b.source)}</code> · batch schema ${esc(b.schemaVersion)} · data: <code>batch.json</code></p>
</section>
</main>
${pageEnd(JS)}`;
}

/** index.md: the same table, for a terminal or a pull request. */
export function batchMarkdown(b: BatchReport): string {
  const s = b.summary;
  const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# Batch report: ${b.name}`,
    '',
    `${b.generatedAt} · ${s.entries} audits · ${s.ok} scored${s.notOk ? ` · ${s.notOk} without a score` : ''}${s.min !== undefined ? ` · scores ${s.min} to ${s.max}, median ${s.median}` : ''}${b.complete ? '' : ' · **incomplete**'}`,
    '',
    '| Entry | Score | Change | A / AA | Pages | Root causes | Critical | Top issue | Status |',
    '|---|--:|--:|--:|--:|--:|--:|---|---|',
  ];
  for (const { e } of worstFirst(b.entries)) {
    const ok = scored(e);
    const href = reportHref(e);
    const label = href ? `[${cell(e.label)}](${href})` : cell(e.label);
    lines.push(
      `| ${label} | ${ok ? `${e.score!.overall} ${BAND_LABEL[band(e.score!.overall)]}` : '–'} | ${ok && e.delta !== undefined ? signed(e.delta) : '–'} | ${ok ? `${e.score!.byLevel.A} / ${e.score!.byLevel.AA}` : ''} | ${e.pagesScanned ?? ''} | ${ok ? (e.issueGroups ?? '') : ''} | ${ok ? (e.byImpact?.critical ?? 0) : ''} | ${ok && e.topIssue ? `\`${e.topIssue.ruleId}\` ${cell(e.topIssue.help)}` : ''} | ${STATUS_LABEL[e.status]}${e.error ? `: ${cell(e.error.split('\n')[0].slice(0, 200))}` : ''} |`,
    );
  }
  lines.push('', 'Each score is that audit\'s own (mean of its worst pages); there is no combined score. Data: `batch.json`.', '');
  return lines.join('\n');
}

// ------------------------------------------------------------------ assets

const JS = `
(function () {
  // Sortable columns: headings become buttons (no script, plain headings). Unscored rows stay last.
  var table = document.getElementById('entries-table');
  if (!table) return;
  var tbody = table.tBodies[0];
  var status = document.getElementById('sort-status');
  var caption = table.querySelector('caption');
  document.querySelectorAll('.js-only').forEach(function (el) { el.hidden = false; });
  var heads = table.querySelectorAll('th[data-sort]');
  heads.forEach(function (th) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = th.textContent;
    th.textContent = '';
    th.appendChild(b);
    b.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      var cur = th.getAttribute('aria-sort');
      var dir = cur ? (cur === 'ascending' ? 'descending' : 'ascending') : (key === 'label' || key === 'score' ? 'ascending' : 'descending');
      heads.forEach(function (h) { h.removeAttribute('aria-sort'); });
      th.setAttribute('aria-sort', dir);
      var rows = Array.prototype.slice.call(tbody.rows);
      rows.sort(function (x, y) {
        var a = x.getAttribute('data-' + key), c = y.getAttribute('data-' + key);
        if (a === '' && c !== '') return 1;
        if (c === '' && a !== '') return -1;
        var r = key === 'label' ? a.localeCompare(c) : Number(a) - Number(c);
        if (dir === 'descending') r = -r;
        return r || Number(x.getAttribute('data-order')) - Number(y.getAttribute('data-order'));
      });
      rows.forEach(function (r) { tbody.appendChild(r); });
      var text = 'Sorted by ' + b.textContent.toLowerCase() + ', ' + dir;
      if (caption) caption.textContent = 'Audit results, ' + text.toLowerCase();
      if (status) status.textContent = text;
    });
  });
})();
`;

const CSS = `
.batch-hero { grid-template-columns: 1.6fr 1fr; }
.bands h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.band-list li { display: flex; align-items: baseline; gap: .5rem; padding: .35rem 0; border-bottom: 1px solid var(--border); font-size: 15px; }
.band-list li:last-child { border-bottom: none; }
.band-list strong { margin-left: auto; font-size: 18px; font-variant-numeric: tabular-nums; }
.band-list .band-text-bad, .band-list .band-text-poor, .band-list .band-text-fair, .band-list .band-text-good { font-weight: 700; }
.sortable { min-width: 60rem; }
.sortable thead th, .nowrap { white-space: nowrap; }
.sortable th[data-sort] button { font: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: inherit; }
.sortable th[data-sort] button::after { content: " ↕"; color: var(--muted); }
.sortable th[aria-sort="ascending"] button::after { content: " ↑"; color: var(--text); }
.sortable th[aria-sort="descending"] button::after { content: " ↓"; color: var(--text); }
.sortable th[aria-sort] { color: var(--text); }
.sortable tbody th { font-weight: 600; min-width: 12rem; }
.entry-url { font-weight: 400; overflow-wrap: anywhere; }
.js-only[hidden] { display: none; }
@media (max-width: 900px) { .batch-hero { grid-template-columns: 1fr; } }
`;
