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

  const md = batchMarkdown(b);
  assert.match(md, /^# Batch report: Q4 <batch>/);
  assert.match(md, /\| \[Bad\]\(\.\.\/\.\.\/\.\.\/b\.com_auth\/20260101-000000\/report\.html\) \| 41 Critical \|/);
  assert.match(md, /\| Broken \| – \|.*Audit failed: net::ERR <x> \|/);
});
