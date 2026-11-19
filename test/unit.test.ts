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
