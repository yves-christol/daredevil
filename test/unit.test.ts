import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScope, normalizeUrl, scopeFromUrl } from '../src/crawl.ts';
import { levelOf, principleOf, successCriteria } from '../src/wcag.ts';
import { nodeSignature, normalizeSelector } from '../src/group.ts';
import { scorePage } from '../src/score.ts';
import { LOGOUT_URL, defaultStateFile, isLoginUrl, sessionLifetime } from '../src/auth.ts';
import type { PageResult, Report, RuleResult } from '../src/types.ts';

test('scope: /shop includes subpaths but not /shopping', () => {
  const s = scopeFromUrl('https://www.mysite.com/shop/');
  assert.deepEqual(s, { origin: 'https://www.mysite.com', pathPrefix: '/shop' });
  assert.ok(inScope('https://www.mysite.com/shop', s));
  assert.ok(inScope('https://www.mysite.com/shop/item/1', s));
  assert.ok(!inScope('https://www.mysite.com/shopping', s));
  assert.ok(!inScope('https://other.com/shop', s));
  assert.ok(!inScope('https://www.mysite.com/shop/catalog.pdf', s));
  assert.deepEqual(scopeFromUrl('https://a.com/demo/before/home.html'), { origin: 'https://a.com', pathPrefix: '/demo/before' });
  assert.deepEqual(scopeFromUrl('https://a.com/'), { origin: 'https://a.com', pathPrefix: '' });
});

test('normalizeUrl strips hash, trailing slash and query', () => {
  assert.equal(normalizeUrl('https://a.com/shop/?x=1#top', false), 'https://a.com/shop');
  assert.equal(normalizeUrl('https://a.com/shop/?x=1', true), 'https://a.com/shop?x=1');
  assert.equal(normalizeUrl('mailto:a@b.c', false), null);
});

test('wcag tag parsing', () => {
  const tags = ['cat.color', 'wcag2aa', 'wcag143'];
  assert.deepEqual(successCriteria(tags), ['1.4.3']);
  assert.equal(levelOf(tags), 'AA');
  assert.equal(principleOf(tags), 'perceivable');
  assert.equal(levelOf(['wcag2a', 'wcag412']), 'A');
  assert.equal(principleOf(['best-practice']), 'best-practice');
});

test('signatures group repeated components', () => {
  assert.equal(normalizeSelector('li:nth-child(3) > .card-12 > img'), 'li > .card-# > img');
  const a = nodeSignature('button-name', 'li:nth-child(1) > button', '<button class="icon-btn btn-2">');
  const b = nodeSignature('button-name', 'li:nth-child(5) > button', '<button class="btn-7 icon-btn">');
  assert.equal(a, b);
  const c = nodeSignature('color-contrast', 'p', '<p>', { fgColor: '#aaa', bgColor: '#fff', fontSize: '12pt', fontWeight: 'normal' });
  assert.match(c, /fg #aaa on bg #fff/);
  assert.equal(nodeSignature('region', 'td > p', '<p class="x">'), 'page structure');
  assert.equal(nodeSignature('image-alt', '#nav > img[src$="a.gif"]', '<img src="a.gif">'), '<img>');
});

function rule(impact: RuleResult['impact'], nodes: number, level: RuleResult['level'] = 'A'): RuleResult {
  return {
    ruleId: 'r', impact, description: '', help: '', helpUrl: '', tags: [], wcag: ['1.1.1'], level, principle: 'perceivable',
    nodes: Array.from({ length: nodes }, (_, i) => ({ selector: `#n${i}`, html: '', signature: 's', groupId: `g${i % 2}` })),
  };
}
const page = (violations: RuleResult[]): PageResult => ({ url: 'u', path: '/', status: 'ok', violations, incomplete: [], passes: [] });

test('score: perfect page is 100, monotonic in nodes and impact', () => {
  assert.equal(scorePage(page([])).overall, 100);
  const s1 = scorePage(page([rule('critical', 1)])).overall;
  const s4 = scorePage(page([rule('critical', 4)])).overall;
  const m1 = scorePage(page([rule('minor', 1)])).overall;
  assert.ok(s4 < s1 && s1 < m1 && m1 < 100);
  // fixing part of the nodes still improves the score
  assert.ok(scorePage(page([rule('critical', 4)]), 'g0').overall > s4);
  // best-practice rules do not affect the headline
  assert.equal(scorePage(page([rule('serious', 3, 'none')])).overall, 100);
});

test('site score: mean of the worst max(10%, 5) pages, not diluted by easy pages', async () => {
  const { scoreSite, rawSiteOverall, worstPageCount } = await import('../src/score.ts');
  assert.deepEqual([3, 5, 10, 49, 50, 51, 158, 246].map(worstPageCount), [3, 5, 5, 5, 5, 6, 16, 25]);
  const bad = page([rule('critical', 1)]); // 90.5
  const worse = page([rule('critical', 4)]);
  const few = [bad, worse, bad];
  const many = [...few, ...Array.from({ length: 60 }, () => page([]))];
  const s = scoreSite(few);
  assert.equal(s.worstPages, 3);
  assert.equal(s.overall, s.mean, 'fewer than 5 pages: all pages count');
  // 63 pages -> worst 7: adding 60 perfect pages must not hide the 3 bad ones as a plain mean would
  const m = scoreSite(many);
  assert.equal(m.worstPages, 7);
  assert.ok(m.overall < 100 && m.mean! > m.overall, `worst ${m.overall} vs mean ${m.mean}`);
  assert.ok(m.mean! > 99);
  // a fix on the bad pages raises the score; gain uses the same rule
  assert.ok(rawSiteOverall(many, 'g0') > rawSiteOverall(many));
});

test('markdownToHtml escapes and renders the agent summary subset', async () => {
  const { markdownToHtml } = await import('../src/html.ts');
  assert.equal(markdownToHtml('## Top\n\n### Sub\n\n```\n# not a heading\n```'), '<h3>Top</h3>\n<h4>Sub</h4>\n<pre><code># not a heading</code></pre>', 'top heading level maps to h3, code fences ignored');
  const html = markdownToHtml('# T\n\nHello **bold** `<b>` <script>x</script>\n\n- a\n  - b\n\n| H | I |\n|---|---|\n| 1 | 2 |');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
  assert.match(html, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<th scope="col">H<\/th>/);
});

test('fix prompt: categories, one MR per category, safe fences, handoff appended', async () => {
  const { categorizeRule, categorizeFinding, buildFixPlan, fixPromptMarkdown } = await import('../src/fixprompt.ts');
  assert.equal(categorizeRule('color-contrast'), 'contrast');
  assert.equal(categorizeRule('aria-required-parent'), 'aria');
  assert.equal(categorizeRule('aria-input-field-name'), 'names');
  assert.equal(categorizeRule('landmark-unique'), 'structure');
  assert.equal(categorizeRule('list'), 'structure');
  assert.equal(categorizeRule('image-alt'), 'images');
  assert.equal(categorizeRule('some-future-rule', ['2.4.7']), 'keyboard');
  assert.equal(categorizeRule('some-future-rule'), 'other');
  assert.equal(categorizeFinding({ id: 'A1', category: 'alt-quality', evidence: '', recommendation: '' }), 'images');
  assert.equal(categorizeFinding({ id: 'A2', category: 'needs-review', wcag: ['1.4.3'], evidence: '', recommendation: '' }), 'contrast');

  const group = (ruleId: string, gain: number, html = '<b>') => ({
    id: ruleId + '-id', ruleId, impact: 'serious' as const, help: ruleId, description: '', helpUrl: 'https://x', wcag: ['1.1.1'],
    level: 'A' as const, principle: 'perceivable' as const, scored: true, signature: 's', occurrences: 1, pageCount: 1, pages: ['/'],
    patterns: ['p'], examples: [{ page: '/', selector: 'p', html }], estimatedScoreGain: gain,
  });
  const report = {
    config: { scope: { origin: 'https://a.com', pathPrefix: '/shop' } },
    summary: { score: { overall: 50, byLevel: { A: 50, AA: 90 } }, pagesScanned: 3, pagesFailed: 0, violations: { groups: 3, nodes: 3 }, needsReview: { groups: 0, nodes: 0 } },
    tool: { version: 't', axeVersion: 'x', scoringVersion: '1' }, generatedAt: 'now', needsReview: [], pages: [],
    issues: [group('color-contrast', 1), group('button-name', 5, '<button>```evil```</button>'), group('link-name', 2)],
  } as unknown as Report;
  const plan = buildFixPlan(report);
  assert.deepEqual(plan.map((c) => c.id), ['names', 'contrast']);
  assert.equal(plan[0].gain, 7);
  const md = fixPromptMarkdown(report, { reportDir: '/r', handoffMd: '# Handoff\n\n## Tasks\nuse group ids' });
  assert.match(md, /## MR 1: Accessible names.*`a11y\/names`/);
  assert.match(md, /## MR 2: Colour and contrast/);
  assert.match(md, /one merge request per category/);
  assert.match(md, /--same-pages \/r\/report\.json/);
  assert.ok(md.includes('````html\n    <button>```evil```</button>\n    ````'), 'fence must outlast backticks in site HTML');
  assert.match(md, /## Appendix: auditor fix guidance[\s\S]*### Handoff[\s\S]*#### Tasks/);
});

test('auth: login pages, logout links, session lifetime', () => {
  const o = 'https://espace-client.orange.fr';
  assert.ok(isLoginUrl('https://login.orange.fr/?return_url=x', o), 'another origin is the login page');
  assert.ok(isLoginUrl(`${o}/login?next=/factures`, o));
  assert.ok(isLoginUrl(`${o}/auth/callback`, o));
  assert.ok(!isLoginUrl(`${o}/factures-paiement`, o));
  assert.ok(!isLoginUrl(`${o}/authors`, o), 'login words must be whole path segments');

  for (const u of ['/logout', '/account/log-out.html', '/se-deconnecter', '/deconnexion', '/auth/signout', '/retirer-contrat/123', '/factures/passage-facture-papier/confirmation', '/facture-paiement/1/changer-iban/vos-informations']) assert.ok(LOGOUT_URL.test(u), u);
  for (const u of ['/logos', '/account/invoices', '/connexion-internet']) assert.ok(!LOGOUT_URL.test(u), u);

  assert.equal(defaultStateFile('https://espace-client.orange.fr/x'), '.auth/espace-client.orange.fr.json');

  const now = Date.parse('2026-11-19T12:00:00Z');
  const cookie = (name: string, domain: string, expires: number) => ({ name, value: 'v', domain, path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' as const });
  const state = { cookies: [cookie('s', '.orange.fr', -1), cookie('t', 'espace-client.orange.fr', now / 1000 + 3600), cookie('x', 'other.com', -1)], origins: [] };
  const life = sessionLifetime(state, `${o}/`, now);
  assert.equal(life.expired, false);
  assert.match(life.text, /^2 cookies for espace-client.orange.fr, 1 session-only.*first expiry 2026-11-19T13:00:00Z$/);
  const old = { cookies: [cookie('t', '.orange.fr', now / 1000 - 10)], origins: [] };
  assert.equal(sessionLifetime(old, `${o}/`, now).expired, true);
});

test('explanations: every in-scope axe rule has a complete plain-language entry', async () => {
  const { explanationFor } = await import('../src/explain.ts');
  const { WCAG_TAGS } = await import('../src/wcag.ts');
  const axe = (await import('axe-core')).default;
  const tags = [...WCAG_TAGS, 'best-practice'];
  const inScope = axe.getRules().filter((r) => r.tags.some((t) => tags.includes(t)) && !r.tags.includes('deprecated'));
  const missing = inScope.map((r) => r.ruleId).filter((id) => {
    const e = explanationFor(id);
    return !e || !e.atStake || !e.affects?.length || !e.fix?.length;
  });
  assert.deepEqual(missing, [], 'add these rules to assets/explanations.json');
});

test('batch: txt and json parsing, resolution, precedence, duplicates', async () => {
  const { parseBatchFile, resolveEntries, batchSummary, batchName, batchSlug } = await import('../src/batch.ts');
  const txt = parseBatchFile('# my batch\nname: Q4 run\nbase: https://a.com/fr\n/shop   Shop pages\n\nhttps://b.com/x#frag  # trailing comment\nc.org\n', 'list.txt');
  assert.equal(txt.name, 'Q4 run');
  assert.equal(batchName(txt, 'x/list.txt'), 'Q4 run');
  assert.equal(batchSlug('Q4 run'), 'Q4_run');
  assert.equal(batchSlug('../../etc'), 'etc', 'no path traversal');
  assert.equal(batchName({ defaults: {}, entries: [] }, 'x/my list.txt'), 'my list');
  const e = resolveEntries(txt, { maxPages: 5, exclude: ['cli'] });
  assert.deepEqual(e.map((x) => x.url), ['https://a.com/shop', 'https://b.com/x#frag', 'https://c.org'], 'URLs are kept as written, like audit');
  assert.deepEqual(e.map((x) => x.label), ['Shop pages', 'b.com/x#frag', 'c.org']);
  assert.equal(e[0].options.maxPages, 5);
  assert.equal(e[0].options.concurrency, 2, 'built-in default');

  const json = parseBatchFile(
    JSON.stringify({ base: 'https://a.com', defaults: { maxPages: 10, exclude: 'file', viewport: '390x844' }, entries: ['/a', { url: '/b', label: 'B', maxPages: 3, exclude: ['entry'] }] }),
    'b.json',
  );
  const j = resolveEntries(json, { maxPages: 7, exclude: ['cli'] });
  assert.deepEqual(j.map((x) => x.options.maxPages), [7, 3], 'file defaults < CLI < entry');
  assert.deepEqual(j[1].options.exclude, ['file', 'cli', 'entry'], 'exclude patterns add up');
  assert.deepEqual(j[0].options.viewport, { width: 390, height: 844 });
  assert.equal(resolveEntries(json, {}, 'https://z.io')[0].url, 'https://z.io/a', '--base overrides the file');

  assert.throws(() => parseBatchFile('{"entries":[{"url":"/a","maxpages":3}]}', 'c.json'), /entries\[0\]: unknown setting "maxpages"/);
  assert.throws(() => parseBatchFile('{"entries":[{"url":"/a","images":true}]}', 'c.json'), /--images \/ --no-images/);
  assert.throws(() => parseBatchFile('{"entries":[{"url":"/a","maxPages":"3"}]}', 'c.json'), /must be a non-negative number/);
  assert.throws(() => resolveEntries(parseBatchFile('/a\n', 'd.txt'), {}), /is a path: give a base URL/);
  assert.throws(() => resolveEntries(parseBatchFile('a.com/shop\nhttps://a.com/shop/\n', 'd.txt'), {}), /entries 1 and 2 audit the same scope/);
  assert.equal(resolveEntries(parseBatchFile('{"entries":["a.com/shop",{"url":"a.com/shop","auth":".auth/a.json"}]}', 'e.json'), {}).length, 2, 'logged in is another scope');
  assert.throws(() => resolveEntries(parseBatchFile('# nothing\n', 'f.txt'), {}), /no entries/);

  const r = (status: 'ok' | 'error', overall?: number) => ({ url: 'u', label: 'l', loggedIn: false, status, ...(overall === undefined ? {} : { score: { overall } as never }) });
  assert.deepEqual(batchSummary([r('ok', 80), r('ok', 50), r('error'), r('ok', 61), r('ok', 70)]), { entries: 5, ok: 4, notOk: 1, min: 50, median: 65.5, max: 80 });
  assert.deepEqual(batchSummary([r('error')]), { entries: 1, ok: 0, notOk: 1 });
});

test('batch page: escaping, safe relative links, worst first, no combined score', async () => {
  const { renderBatchHtml, batchMarkdown, reportHref } = await import('../src/batchhtml.ts');
  const { batchSummary } = await import('../src/batch.ts');
  const score = (overall: number) => ({ overall, byLevel: { A: overall, AA: 90 }, byPrinciple: { perceivable: 1, operable: 1, understandable: 1, robust: 1 }, bestPractice: 80 });
  const entries = [
    { url: 'https://a.com/x', label: 'Good <one>', loggedIn: false, status: 'ok' as const, reportDir: '../../../a.com_x/20260101-000000', score: score(92), delta: 1.5, pagesScanned: 5, issueGroups: 2, byImpact: { critical: 0, serious: 1, moderate: 0, minor: 0 },
      topIssue: { id: 'g', ruleId: 'image-alt', help: 'Images <b>must</b>', impact: 'critical' as const, signature: 's', pageCount: 1, estimatedScoreGain: 3 } },
    { url: 'https://b.com/', label: 'Bad', loggedIn: true, status: 'ok' as const, reportDir: '../../../b.com_auth/20260101-000000', score: score(41), pagesScanned: 3, issueGroups: 9, byImpact: { critical: 4, serious: 0, moderate: 0, minor: 0 } },
    { url: 'https://c.com/', label: 'Broken', loggedIn: false, status: 'error' as const, error: 'net::ERR <x>', reportDir: 'javascript:alert(1)' },
  ];
  const b = { schemaVersion: '1.0.0', tool: { name: 'daredevil' as const, version: 't', scoringVersion: '2.0.0' }, name: 'Q4 <batch>', source: 'list.txt', generatedAt: '2026-11-19T12:00:00Z', complete: true,
    imageScreenshots: { loggedOut: true, loggedIn: false }, summary: batchSummary(entries), entries };
  const html = renderBatchHtml(b, { summaryMd: '# Brief\n\nFix **Bad** first <script>' });

  assert.ok(!html.includes('<one>') && !html.includes('<b>must') && !html.includes('<script>x') && !html.includes('<batch>'), 'site-derived text is escaped');
  assert.equal(html.match(/<script>/g)?.length, 2, 'only the theme and page scripts');
  assert.ok(html.includes('&lt;script&gt;'), 'agent summary is escaped');
  assert.ok(html.includes('href="../../../a.com_x/20260101-000000/report.html"'));
  assert.ok(!html.includes('javascript:'), 'non-relative report paths are not linked');
  assert.equal(reportHref({ ...entries[0], reportDir: '/etc' }), undefined);
  assert.ok(html.indexOf('>Bad<') < html.indexOf('Good &lt;one&gt;') && html.indexOf('Good &lt;one&gt;') < html.indexOf('>Broken'), 'worst first, unscored last');
  assert.match(html, /Some audits ran with a saved login session/);
  assert.match(html, /does not combine them into one score/);
  assert.match(html, /<a class="skip" href="#entries">/);

  const reviewedHtml = renderBatchHtml(b, { reviewed: new Set([0, 2]) });
  assert.ok(reviewedHtml.includes('<a class="small" href="../../../a.com_x/20260101-000000/report.html#summary">AI review</a>'), 'reviewed entry links to its summary');
  assert.equal(reviewedHtml.match(/>AI review</g)?.length, 1, 'only scored entries with a report get the link');
  assert.match(batchMarkdown(b, new Set([0])), /\| Scored · AI review \|/);

  const md = batchMarkdown(b);
  assert.match(md, /^# Batch report: Q4 <batch>/);
  assert.match(md, /\| \[Bad\]\(\.\.\/\.\.\/\.\.\/b\.com_auth\/20260101-000000\/report\.html\) \| 41 Critical \|/);
  assert.match(md, /\| Broken \| – \|.*Audit failed: net::ERR <x> \|/);
});

test('batch: shared root causes, previous batch, change column', async () => {
  const { sharedIssues, previousInfo } = await import('../src/batch.ts');
  const { renderBatchHtml, batchMarkdown, changeOf } = await import('../src/batchhtml.ts');
  const g = (id: string, occurrences: number, gain: number, impact: 'critical' | 'minor' = 'critical') => ({
    id, ruleId: 'rule-' + id, impact, help: `Help <${id}>`, description: '', helpUrl: 'https://x', wcag: [], level: 'A' as const, principle: 'perceivable' as const,
    scored: true, signature: `sig <${id}>`, occurrences, pageCount: 1, pages: ['/'], patterns: [], examples: [], estimatedScoreGain: gain,
  });
  const ok = (label: string, url: string, extra = {}) => ({ url, label, loggedIn: false, status: 'ok' as const, reportDir: `../../../${label}/s`, score: { overall: 70, byLevel: { A: 70, AA: 90 }, byPrinciple: { perceivable: 1, operable: 1, understandable: 1, robust: 1 }, bestPractice: 80 }, ...extra });
  const entries = [ok('A', 'https://s.com/a'), ok('B', 'https://s.com/b'), ok('C', 'https://s.com/c'), { url: 'https://s.com/d', label: 'D', loggedIn: false, status: 'error' as const }];
  const issues = [[g('x', 3, 1), g('y', 1, 5)], [g('x', 2, 2), g('y', 4, 1), g('z', 9, 9)], [g('x', 1, 0.5)], [g('z', 1, 1)]];
  const shared = sharedIssues(entries, issues);
  assert.deepEqual(shared.map((s) => s.id), ['x', 'y'], 'in 2+ scored entries, most widespread first; failed entries ignored');
  assert.equal(shared[0].occurrences, 6);
  assert.deepEqual(shared[0].entries.map((e) => [e.label, e.estimatedScoreGain]), [['A', 1], ['B', 2], ['C', 0.5]]);
  assert.equal(sharedIssues(entries, issues, 1).length, 1, 'limit');

  const prevBatch = { entries: [{ url: 'https://s.com/a', label: 'A', loggedIn: false }, { url: 'https://s.com/old', label: 'Old <one>', loggedIn: false }, { url: 'https://s.com/b', label: 'B', loggedIn: true }], generatedAt: '2026-11-01T00:00:00Z', summary: { entries: 3, ok: 3, notOk: 0, median: 60 } };
  const info = previousInfo({ dir: '/r/_batches/q/20261101-000000', batch: prevBatch as never }, '/r/_batches/q/20261119-000000', entries);
  assert.equal(info.dir, '../20261101-000000');
  assert.deepEqual(info.added, ['B', 'C', 'D'], 'B was logged in before: another scope');
  assert.deepEqual(info.removed, ['Old <one>', 'B'], 'the logged-in B is gone');

  const cur = [
    { ...entries[0], sincePrevious: { before: 65, delta: 5, comparable: true, fixed: 2, introduced: 1 } },
    { ...entries[1], newSincePrevious: true as const, delta: 3 },
    { ...entries[2], sincePrevious: { before: 71, delta: -1, comparable: false } },
  ];
  const b = { schemaVersion: '1.0.0', tool: { name: 'daredevil' as const, version: 't', scoringVersion: '2.0.0' }, name: 'q', source: 'q.txt', generatedAt: '2026-11-19T00:00:00Z', complete: true,
    imageScreenshots: { loggedOut: true, loggedIn: false }, summary: { entries: 3, ok: 3, notOk: 0, min: 70, median: 70, max: 70 }, entries: cur, shared, previous: info };
  assert.deepEqual(changeOf(b, cur[1]), { isNew: true }, 'with a previous batch, the per-scope delta is not used');
  assert.equal(changeOf({ ...b, previous: undefined }, cur[1]).delta, 3, 'without one, it is');

  const html = renderBatchHtml(b);
  assert.match(html, /<a href="\.\.\/20261101-000000\/index\.html">1 November 2026/);
  assert.match(html, /median 60 → 70/);
  assert.match(html, /2 removed \(Old &lt;one&gt;, B\)/);
  assert.match(html, /\+5<br><span class="muted small">2 fixed · 1 new<\/span>/);
  assert.match(html, /-1<br><span class="muted small">not strictly comparable/);
  assert.match(html, /<span class="muted">new<\/span>/);
  assert.match(html, /<h2 id="shared-h">Shared root causes <span class="count">2<\/span>/);
  assert.match(html, /<a href="\.\.\/\.\.\/\.\.\/B\/s\/report\.html">B<\/a> <span class="muted">\+2<\/span>/);
  assert.ok(!html.includes('<x>') && !html.includes('sig <'), 'shared issue text is escaped');
  assert.match(html, /href="#shared">Shared issues/);

  const md = batchMarkdown(b);
  assert.match(md, /Compared with the previous batch \(2026-11-01T00:00:00Z\): median 60 → 70, 3 added, 2 removed \(Old <one>, B\)\./);
  assert.match(md, /\| -1\* \|/);
  assert.match(md, /## Shared root causes[\s\S]*\| `rule-x` Help <x> \(`sig <x>`\) \| 3 \/ 3 \| 6 \| A \+1, B \+2, C \+0\.5 \|/);
});

test('batch: parallel pool never runs two audits of one origin at once', async () => {
  const { runPool } = await import('../src/batch.ts');
  const items = ['a1', 'a2', 'b1', 'c1', 'b2', 'd1'];
  let active = 0, maxActive = 0;
  const busy = new Set<string>();
  const started: string[] = [];
  await runPool(items, 3, (x) => x[0], async (x) => {
    assert.ok(!busy.has(x[0]), `two '${x[0]}' at once`);
    busy.add(x[0]);
    started.push(x);
    maxActive = Math.max(maxActive, ++active);
    await new Promise((r) => setTimeout(r, x === 'a1' ? 30 : 5));
    active--;
    busy.delete(x[0]);
  });
  assert.equal(maxActive, 3);
  assert.deepEqual(started.slice(0, 3), ['a1', 'b1', 'c1'], 'a2 waits for a1; the next free origins start');
  assert.deepEqual([...started].sort(), [...items].sort(), 'every item runs once');
  assert.ok(started.indexOf('a2') > started.indexOf('b2'), 'a2 waited for a1 while others went ahead');

  const order: number[] = [];
  await runPool([1, 2, 3], 1, String, async (x) => void order.push(x));
  assert.deepEqual(order, [1, 2, 3], 'parallel 1 keeps file order');
});

test('batch: --same-pages-from maps each entry to its scope in another batch', async () => {
  const { applySamePagesFrom, resolveEntries, parseBatchFile } = await import('../src/batch.ts');
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const out = await mkdtemp(join(tmpdir(), 'dd-sp-'));
  const dir = join(out, '_batches', 'q', '20261101-000000');
  await mkdir(dir, { recursive: true });
  const prev = {
    complete: true, generatedAt: 'x', summary: {},
    entries: [
      { url: 'https://s.com/a', label: 'A', loggedIn: false, status: 'ok', reportDir: '../../../s.com_a/1' },
      { url: 'https://s.com/b', label: 'B', loggedIn: false, status: 'no-pages', reportDir: '../../../s.com_b/1' },
    ],
  };
  await writeFile(join(dir, 'batch.json'), JSON.stringify(prev));
  const make = () => resolveEntries(parseBatchFile('{"base":"https://s.com","entries":["/a","/b","/c",{"url":"/d","samePages":"own.json"}]}', 'q.json'), {});

  const e = make();
  const r = await applySamePagesFrom(e, dir, { out, name: 'q' });
  assert.equal(e[0].options.samePages, join(dir, '../../../s.com_a/1', 'report.json'));
  assert.equal(e[1].options.samePages, undefined);
  assert.equal(e[3].options.samePages, 'own.json', "an entry's own samePages wins");
  assert.deepEqual(r.warnings, ['s.com/b: not scored in that batch (no-pages), crawled normally', 's.com/c: not in that batch, crawled normally']);

  const latest = make();
  await applySamePagesFrom(latest, 'latest', { out, name: 'q' });
  assert.equal(latest[0].options.samePages, e[0].options.samePages, "'latest' finds the last complete batch of this name");
  await assert.rejects(applySamePagesFrom(make(), 'latest', { out, name: 'other' }), /no complete batch named "other"/);
  await assert.rejects(applySamePagesFrom(make(), join(out, 'nope'), { out, name: 'q' }), /no such batch file/);
});
