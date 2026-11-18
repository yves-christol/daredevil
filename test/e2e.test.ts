import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveFixtures } from './helpers.ts';
import { runAudit } from '../src/audit.ts';
import { buildReport } from '../src/report.ts';
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
      keyboardProbe: true, imageCapture: false,
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
  } finally {
    server.close();
  }
});
