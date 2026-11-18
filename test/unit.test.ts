import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScope, normalizeUrl, scopeFromUrl } from '../src/crawl.ts';
import { levelOf, principleOf, successCriteria } from '../src/wcag.ts';
import { nodeSignature, normalizeSelector } from '../src/group.ts';
import { scorePage } from '../src/score.ts';
import type { PageResult, RuleResult } from '../src/types.ts';

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

test('markdownToHtml escapes and renders the agent summary subset', async () => {
  const { markdownToHtml } = await import('../src/html.ts');
  const html = markdownToHtml('# T\n\nHello **bold** `<b>` <script>x</script>\n\n- a\n  - b\n\n| H | I |\n|---|---|\n| 1 | 2 |');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
  assert.match(html, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<th scope="col">H<\/th>/);
});
