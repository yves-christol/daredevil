import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveFixtures } from './helpers.ts';
import { runAudit } from '../src/audit.ts';
import { buildReport } from '../src/report.ts';
import { renderHtml } from '../src/html.ts';
import { scopeFromUrl } from '../src/crawl.ts';
import type { AuditConfig } from '../src/types.ts';

test('audits the /shop subtree of the fixture site', { timeout: 120_000 }, async () => {
  const { url, server } = await serveFixtures();
  try {
    const startUrl = `${url}/shop`;
    const config: AuditConfig = {
      startUrl, scope: scopeFromUrl(startUrl), maxPages: 10, concurrency: 2,
      viewport: { width: 1280, height: 800 }, waitMs: 0, timeoutMs: 15000, keepQuery: false,
      tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      keyboardProbe: true, imageCapture: false, dismissConsent: true,
    };
    const dir = await mkdtemp(join(tmpdir(), 'dd-'));
    const run = await runAudit(config, dir, () => {});
    const paths = run.pages.map((p) => p.path).sort();
    assert.deepEqual(paths, ['/shop', '/shop/product-1.html', '/shop/product-2.html']);

    const report = buildReport(config, run.pages, { version: 'test', axeVersion: run.axeVersion, browser: run.browser });
    const rules = new Set(report.issues.map((g) => g.ruleId));
    for (const r of ['image-alt', 'button-name', 'color-contrast', 'html-has-lang', 'label']) assert.ok(rules.has(r), `expected ${r}`);

    // 3 identical icon buttons on /shop + 1 per product page => one root-cause group across 3 pages
    const btn = report.issues.find((g) => g.ruleId === 'button-name')!;
    assert.equal(btn.occurrences, 5);
    assert.equal(btn.pageCount, 3);
    // all #aaa-on-white text shares one contrast group
    assert.equal(report.issues.filter((g) => g.ruleId === 'color-contrast').length, 1);

    assert.ok(report.summary.score.overall > 0 && report.summary.score.overall < 100);
    assert.ok(report.issues[0].estimatedScoreGain >= report.issues.at(-1)!.estimatedScoreGain);
    const product = run.pages.find((p) => p.path === '/shop/product-1.html')!;
    assert.equal(product.keyboard?.hasSkipLink, true);
    // shadow-DOM links are counted and reached by the keyboard probe
    const p2 = run.pages.find((p) => p.path === '/shop/product-2.html')!.keyboard!;
    assert.ok(p2.tabbableElements >= 6, `tabbable ${p2.tabbableElements}`);
    assert.equal(p2.tabStops, p2.tabbableElements);
    assert.equal(p2.possibleTrap, undefined);
    // the fake consent dialog is dismissed with the "reject" choice, never "accept"
    assert.equal(product.consent?.dismissed, true);
    assert.match(product.consent?.method ?? '', /Continuer sans accepter/);
    assert.equal(run.pages.find((p) => p.path === '/shop')!.consent?.dismissed, false);

    // HTML report renders and escapes untrusted snippets from the audited site
    const html = renderHtml(report);
    assert.match(html, /<html lang="en">/);
    assert.ok(!html.includes('<button class="icon-btn"></button>'), 'raw site HTML must be escaped');
    assert.ok(html.includes('&lt;button class=&quot;icon-btn&quot;&gt;'));
  } finally {
    server.close();
  }
});
