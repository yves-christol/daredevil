import type { BatchEntryResult, BatchReport, EntryStatus, SharedIssue } from './batch.ts';
import { BAND_ICON, BAND_LABEL, band, esc, fmt, impactBadge, markdownToHtml, pageEnd, pageStart, ring, signed, type Band } from './htmlkit.ts';

/**
 * The batch page (index.html) and its markdown twin (index.md). The page opens on a grid of
 * score dials, one per entry (worst first), each linking to its detailed report.html; the full
 * sortable table sits in a collapsed "Details" section below. There is no combined score: each
 * entry keeps its own, and the page shows their spread.
 */

export interface BatchExtras {
  /** The agent's batch-level brief (summary.md in the batch folder). */
  summaryMd?: string;
  /** Indexes of entries with an agent review (summary.md in their report folder). */
  reviewed?: Set<number>;
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

/** Plain relative folder (no scheme, not absolute), or undefined. */
const relDir = (d: string | undefined) => (d && !/^[a-z][\w+.-]*:/i.test(d) && !d.startsWith('/') ? d.split('\\').join('/') : undefined);

/**
 * The Change column. With a previous batch, every row compares with it (entries it did not have
 * are "new"); without one, each row compares with the previous audit of its scope.
 */
interface Change {
  delta?: number;
  comparable?: boolean;
  isNew?: boolean;
  fixed?: number;
  introduced?: number;
}
export function changeOf(b: BatchReport, e: BatchEntryResult): Change {
  if (!scored(e)) return {};
  if (b.previous) {
    if (e.newSincePrevious) return { isNew: true };
    const p = e.sincePrevious;
    return p ? { delta: p.delta, comparable: p.comparable, fixed: p.fixed, introduced: p.introduced } : {};
  }
  return { delta: e.delta, comparable: e.comparableWithPrevious };
}

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

function dial(b: BatchReport, { e }: { e: BatchEntryResult; order: number }): string {
  const href = reportHref(e);
  const ok = scored(e);
  const c = changeOf(b, e);
  const label = href ? `<a href="${esc(href)}">${esc(e.label)}</a>` : esc(e.label);
  const change =
    c.delta !== undefined
      ? `<span class="${c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : 'muted'}">${signed(c.delta)}</span>${c.comparable === false ? '<span class="muted">*</span>' : ''}`
      : c.isNew
        ? '<span class="muted">new</span>'
        : '';
  const bd = ok ? band(e.score!.overall) : undefined;
  return `<li class="dial${ok ? '' : ' dial-none'}">
  ${ok ? ring(e.score!.overall, 120) : `<div class="dial-empty" aria-hidden="true">–</div>`}
  <h3>${label}</h3>
  <p class="small">${ok ? `<span class="band-text-${bd}"><span aria-hidden="true">${BAND_ICON[bd!]}</span> ${BAND_LABEL[bd!]}</span>${change ? ` · ${change}` : ''}` : `<span class="${e.status === 'pending' ? 'muted' : 'warn-text'}"><span aria-hidden="true">${e.status === 'pending' ? '…' : '✕'}</span> ${STATUS_LABEL[e.status]}</span>`}${e.loggedIn ? '<span class="muted"> · logged in</span>' : ''}</p>
</li>`;
}

function row(b: BatchReport, { e, order }: { e: BatchEntryResult; order: number }, reviewed: boolean): string {
  const href = reportHref(e);
  const ok = scored(e);
  const s = e.score;
  const bd = ok ? band(s!.overall) : undefined;
  const num = (v: number | undefined) => (v === undefined ? '' : String(v));
  const c = changeOf(b, e);
  const groupsMoved = c.fixed !== undefined && (c.fixed || c.introduced) ? `<br><span class="muted small">${c.fixed} fixed · ${c.introduced} new</span>` : '';
  const delta =
    c.delta !== undefined
      ? `<td class="num ${c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : ''}">${signed(c.delta)}${c.comparable === false ? '<br><span class="muted small">not strictly comparable</span>' : ''}${groupsMoved}</td>`
      : c.isNew
        ? '<td class="num"><span class="muted">new</span></td>'
        : '<td class="num"><span class="muted">–</span></td>';
  const top = e.topIssue;
  return `<tr data-order="${order}" data-label="${esc(e.label.toLowerCase())}" data-score="${ok ? s!.overall : ''}" data-delta="${num(c.delta)}" data-pages="${num(e.pagesScanned)}" data-groups="${ok ? num(e.issueGroups) : ''}" data-critical="${ok ? num(e.byImpact?.critical) : ''}">
  <th scope="row">${href ? `<a href="${esc(href)}">${esc(e.label)}</a>` : esc(e.label)}<br><span class="muted small entry-url">${(e.urls ?? [e.url]).map((u) => esc(u.replace(/^https?:\/\//, '')).replace(/\//g, '/<wbr>')).join(' + ')}${e.loggedIn ? ' · logged in' : ''}</span></th>
  <td class="num">${ok ? `<span class="pill band-${bd}">${s!.overall}</span><br><span class="small band-text-${bd}"><span aria-hidden="true">${BAND_ICON[bd!]}</span> ${BAND_LABEL[bd!]}</span>` : '<span class="muted">–</span>'}</td>
  ${delta}
  <td class="num nowrap">${ok ? `${s!.byLevel.A}<span class="muted"> / </span>${s!.byLevel.AA}` : ''}</td>
  <td class="num">${num(e.pagesScanned)}${e.pagesFailed ? `<br><span class="warn-text small">${e.pagesFailed} failed</span>` : ''}</td>
  <td class="num">${ok ? num(e.issueGroups) : ''}</td>
  <td class="num">${ok ? fmt(e.byImpact?.critical ?? 0) : ''}</td>
  <td>${ok && top ? `${esc(top.help)}<br><span class="muted small">${impactBadge(top.impact)} ${top.estimatedScoreGain > 0 ? `${signed(top.estimatedScoreGain)} pts · ` : ''}${top.pageCount} page${top.pageCount === 1 ? '' : 's'}</span>` : ''}</td>
  <td>${ok ? `<span class="ok-icon" aria-hidden="true">✓</span> ${STATUS_LABEL.ok}${reviewed && href ? `<br><a class="small" href="${esc(href)}#summary">AI review</a>` : ''}` : `<span class="${e.status === 'pending' ? 'muted' : 'warn-text'}"><span aria-hidden="true">${e.status === 'pending' ? '…' : '✕'}</span> ${STATUS_LABEL[e.status]}</span>`}${e.error ? `<br><span class="muted small">${esc(e.error.split('\n')[0].slice(0, 300))}</span>` : ''}${e.stopped ? `<br><span class="muted small">${esc(e.stopped)}</span>` : ''}</td>
</tr>`;
}

export function renderBatchHtml(b: BatchReport, extras: BatchExtras = {}): string {
  const s = b.summary;
  const pending = b.entries.filter((e) => e.status === 'pending').length;
  const anyLoggedIn = b.entries.some((e) => e.loggedIn);
  const nav: [string, string][] = [
    ['#entries', 'Scores'],
    ...(extras.summaryMd ? [['#summary', 'Summary'] as [string, string]] : []),
    ['#details', 'Details'],
    ...(b.shared?.length ? [['#shared', 'Shared issues'] as [string, string]] : []),
    ['#method', 'Method'],
  ];

  return `${pageStart({
    title: `Batch report: ${b.name}`,
    kicker: 'batch report',
    skip: { href: '#entries', label: 'Skip to scores' },
    nav,
    navLabel: 'Batch report sections',
    css: CSS,
  })}
<main id="main" class="wrap">
<section class="batch-head" aria-labelledby="title">
  <h1 id="title">${esc(b.name)}</h1>
  <p class="muted">${dateLabel(b.generatedAt)} · ${s.entries} audit${s.entries === 1 ? '' : 's'}${s.notOk ? ` · <strong>${s.notOk} without a score</strong>` : ''}${s.median !== undefined ? ` · median ${s.median}` : ''}</p>
  ${b.previous ? previousLine(b) : ''}
  ${!b.complete ? `<p class="warn" role="note">⚠ Batch ${pending ? `incomplete: ${pending} audit${pending === 1 ? '' : 's'} not run yet (still running, or interrupted)` : 'did not finish cleanly'}.</p>` : ''}
  ${anyLoggedIn ? '<p class="warn" role="note">⚠ Some audits ran with a saved login session. Their reports may contain personal data from the account. Review before sharing.</p>' : ''}
</section>

<section id="entries" aria-labelledby="entries-h">
  <h2 id="entries-h" class="visually-hidden">Scores</h2>
  <ul class="dial-grid">
    ${worstFirst(b.entries).map((x) => dial(b, x)).join('\n')}
  </ul>
  <p class="muted small legend">Worst first. ${(['bad', 'poor', 'fair', 'good'] as Band[]).map((k) => `<span class="band-text-${k}"><span aria-hidden="true">${BAND_ICON[k]}</span> ${BAND_LABEL[k]}</span> ${k === 'good' ? '90+' : k === 'fair' ? '75–89' : k === 'poor' ? '50–74' : 'under 50'}`).join(' · ')}${b.entries.some((e) => changeOf(b, e).comparable === false) ? ' · * not strictly comparable' : ''}</p>
</section>

${extras.summaryMd ? `<section id="summary" aria-labelledby="summary-h" class="prose card">
  <h2 id="summary-h">Summary</h2>
  ${markdownToHtml(extras.summaryMd.replace(/^#\s+.*\n/, ''))}
</section>` : ''}

<section id="details" aria-labelledby="details-h">
  <details class="card">
  <summary><h2 id="details-h" class="inline-h">Details <span class="count">${b.entries.length}</span></h2></summary>
  <p class="lede">One row per audit, worst score first. Scores: WCAG 2.2 A + AA, mean of each audit's worst pages. ${b.previous ? `Change: since the previous batch (${esc(dateLabel(b.previous.generatedAt))}).` : 'Change: since the previous audit of the same scope.'}<span class="js-only" hidden> Select a column heading to sort.</span></p>
  <div class="table-wrap" tabindex="0" role="region" aria-label="Results table, scrollable"><table class="sortable" id="entries-table">
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
    ${worstFirst(b.entries).map((x) => row(b, x, !!extras.reviewed?.has(x.order))).join('\n')}
    </tbody>
  </table></div>
  <p class="visually-hidden" aria-live="polite" id="sort-status"></p>
  </details>
</section>

${b.shared?.length ? sharedSection(b) : ''}

<section id="method" aria-labelledby="method-h" class="prose">
  <h2 id="method-h">Method and limits</h2>
  <p>Each entry is a separate audit with its own crawl and score (scoring v${esc(b.tool.scoringVersion)}): the mean of that audit's lowest-scoring pages. This page does not combine them into one score. Compare entries only when they were audited with the same options; the detailed reports list the options used.</p>
  <p><strong>Change</strong> compares each audit with ${b.previous ? 'the same scope in the previous batch of the same name' : 'the previous audit of the same scope'}. “Not strictly comparable” means the two runs scanned different pages, or ran with different tool versions or options: re-run with <code>samePages</code> for a strict comparison.</p>
  <p><strong>Shared root causes</strong> are issue groups with the same rule and the same signature (component, selector pattern or colour pair) in several audits. Gains are per audit, each on its own score: they do not add up to one number.</p>
  <p><strong>Limits.</strong> Automated rules find only part of WCAG failures. A high score means few detectable violations, not conformance.</p>
  <p class="muted small">daredevil ${esc(b.tool.version)} · batch file <code>${esc(b.source)}</code> · batch schema ${esc(b.schemaVersion)} · data: <code>batch.json</code></p>
</section>
</main>
${pageEnd(JS)}`;
}

/** index.md: the same table, for a terminal or a pull request. */
export function batchMarkdown(b: BatchReport, reviewed?: Set<number>): string {
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
  if (b.previous) {
    const p = b.previous;
    lines.splice(4, 0, `Compared with the previous batch (${p.generatedAt})${p.summary.median !== undefined && s.median !== undefined ? `: median ${p.summary.median} → ${s.median}` : ''}${p.added.length ? `, ${p.added.length} added` : ''}${p.removed.length ? `, ${p.removed.length} removed (${p.removed.map(cell).join(', ')})` : ''}.`, '');
  }
  for (const { e, order } of worstFirst(b.entries)) {
    const c = changeOf(b, e);
    const ok = scored(e);
    const href = reportHref(e);
    const label = href ? `[${cell(e.label)}](${href})` : cell(e.label);
    lines.push(
      `| ${label} | ${ok ? `${e.score!.overall} ${BAND_LABEL[band(e.score!.overall)]}` : '–'} | ${c.delta !== undefined ? `${signed(c.delta)}${c.comparable === false ? '*' : ''}` : c.isNew ? 'new' : '–'} | ${ok ? `${e.score!.byLevel.A} / ${e.score!.byLevel.AA}` : ''} | ${e.pagesScanned ?? ''} | ${ok ? (e.issueGroups ?? '') : ''} | ${ok ? (e.byImpact?.critical ?? 0) : ''} | ${ok && e.topIssue ? `\`${e.topIssue.ruleId}\` ${cell(e.topIssue.help)}` : ''} | ${STATUS_LABEL[e.status]}${reviewed?.has(order) ? ' · AI review' : ''}${e.error ? `: ${cell(e.error.split('\n')[0].slice(0, 200))}` : ''} |`,
    );
  }
  if (b.shared?.length) {
    lines.push('', '## Shared root causes', '', 'Same rule and signature in several audits: usually one fix in a shared template.', '', '| Root cause | Audits | Elements | Where (gain if fixed) |', '|---|--:|--:|---|');
    for (const x of b.shared) {
      lines.push(`| \`${x.ruleId}\` ${cell(x.help)} (\`${cell(x.signature)}\`) | ${x.entries.length} / ${s.ok} | ${x.occurrences} | ${x.entries.map((en) => `${cell(en.label)}${x.scored && en.estimatedScoreGain > 0 ? ` ${signed(en.estimatedScoreGain)}` : ''}`).join(', ')} |`);
    }
  }
  lines.push('', `${b.previous ? 'Change: since the previous batch' : 'Change: since the previous audit of the same scope'}; * = not strictly comparable (other pages, versions or options). Each score is that audit\'s own (mean of its worst pages); there is no combined score. Data: \`batch.json\`.`, '');
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
.batch-head { margin-top: 1.5rem; }
.batch-head p { margin: .2rem 0; }
.dial-grid { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: 1rem; }
.dial { position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1rem .75rem .85rem; }
.dial:has(a:hover) { border-color: var(--control); }
.dial h3 { margin: .5rem 0 .15rem; font-size: 15px; overflow-wrap: anywhere; }
.dial h3 a::before { content: ""; position: absolute; inset: 0; border-radius: 12px; }
.dial p { margin: 0; }
.dial .up { color: var(--good); } .dial .down { color: var(--bad); }
.dial-empty { width: 120px; height: 120px; border-radius: 50%; border: 14px solid var(--ring-track); display: grid; place-items: center; font-size: 28px; color: var(--muted); }
.legend { margin-top: 1rem; }
details.card > summary .inline-h { display: inline; margin: 0; }
details.card[open] > summary { margin-bottom: .8rem; }
.sortable { min-width: 60rem; }
.sortable thead th, .nowrap { white-space: nowrap; }
.sortable th[data-sort] button { font: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: inherit; }
.sortable th[data-sort] button::after { content: " ↕"; color: var(--muted); }
.sortable th[aria-sort="ascending"] button::after { content: " ↑"; color: var(--text); }
.sortable th[aria-sort="descending"] button::after { content: " ↓"; color: var(--text); }
.sortable th[aria-sort] { color: var(--text); }
.sortable tbody th { font-weight: 600; min-width: 12rem; }
.entry-url { font-weight: 400; overflow-wrap: break-word; }
.js-only[hidden] { display: none; }
.shared { min-width: 44rem; }
.shared tbody th { font-weight: 600; max-width: 32rem; }
.audits { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .35rem; }
.audits li { font-size: 14px; border: 1px solid var(--border); border-radius: 999px; padding: .1rem .65rem; }
`;

function previousLine(b: BatchReport): string {
  const p = b.previous!;
  const dir = relDir(p.dir);
  const when = esc(dateLabel(p.generatedAt));
  const med = p.summary.median !== undefined && b.summary.median !== undefined ? ` · median ${p.summary.median} → ${b.summary.median}` : '';
  const moved = [p.added.length && `${p.added.length} audit${p.added.length === 1 ? '' : 's'} added`, p.removed.length && `${p.removed.length} removed (${p.removed.map(esc).join(', ')})`].filter(Boolean).join(' · ');
  return `<p class="muted">Compared with the previous batch, ${dir ? `<a href="${esc(encodeURI(dir + '/index.html'))}">${when}</a>` : when}${med}${moved ? ` · ${moved}` : ''}</p>`;
}

function sharedSection(b: BatchReport): string {
  const scoredCount = b.summary.ok;
  const item = (x: SharedIssue) => {
    const audits = x.entries
      .map((en) => {
        const href = reportHref(b.entries[en.index] ?? ({} as BatchEntryResult));
        const label = esc(en.label);
        const gain = x.scored && en.estimatedScoreGain > 0 ? ` <span class="muted">${signed(en.estimatedScoreGain)}</span>` : '';
        return `<li>${href ? `<a href="${esc(href)}">${label}</a>` : label}${gain}</li>`;
      })
      .join('');
    return `<tr>
  <th scope="row">${esc(x.help)}<br><span class="muted small">${impactBadge(x.impact)} <code>${esc(x.ruleId)}</code> <code>${esc(x.signature)}</code></span></th>
  <td class="num">${x.entries.length}<span class="muted"> / ${scoredCount}</span></td>
  <td class="num">${fmt(x.occurrences)}</td>
  <td><ul class="chips audits">${audits}</ul></td>
</tr>`;
  };
  return `<section id="shared" aria-labelledby="shared-h">
  <h2 id="shared-h">Shared root causes <span class="count">${b.shared!.length}</span></h2>
  <p class="lede">The same defect, on the same component or style, in several audits. It usually lives in a shared template or stylesheet: one fix repairs every audit listed. Most widespread first; points are the estimated gain on each audit's own score.</p>
  <div class="table-wrap" tabindex="0" role="region" aria-label="Shared root causes table, scrollable"><table class="shared">
    <thead><tr><th scope="col">Root cause</th><th scope="col" class="num">Audits</th><th scope="col" class="num">Elements</th><th scope="col">Where (gain if fixed)</th></tr></thead>
    <tbody>${b.shared!.map(item).join('\n')}</tbody>
  </table></div>
</section>`;
}
