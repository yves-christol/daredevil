import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveFixtures } from './helpers.ts';
import { runAudit } from '../src/audit.ts';
import { buildReport, diffReports, reportMarkdown } from '../src/report.ts';
import { LOGOUT_URL, captureSession } from '../src/auth.ts';
import { renderHtml } from '../src/html.ts';
import { buildFixPlan, fixPromptMarkdown } from '../src/fixprompt.ts';
import { scopeFromUrl } from '../src/crawl.ts';
import type { AuditConfig } from '../src/types.ts';

test('one audit of several start URLs on two hosts: shared budget, host in page paths', { timeout: 120_000 }, async () => {
  const a = await serveFixtures();
  const b = await serveFixtures();
  try {
    const startUrls = [`${a.url}/shop`, `${b.url}/shop/product-2.html`];
    const config: AuditConfig = {
      startUrl: startUrls[0], scope: scopeFromUrl(startUrls[0]), startUrls, scopes: startUrls.map(scopeFromUrl),
      maxPages: 4, concurrency: 2,
      viewport: { width: 1280, height: 800 }, waitMs: 0, timeoutMs: 15000, keepQuery: false,
      tags: ['wcag2a', 'wcag2aa'], keyboardProbe: false, imageInventory: false, imageScreenshots: false, dismissConsent: false,
    };
    const run = await runAudit(config, await mkdtemp(join(tmpdir(), 'dd-')), () => {});
    const hostA = new URL(a.url).host, hostB = new URL(b.url).host;
    const paths = run.pages.map((p) => p.path);
    // /shop on host A has 3 pages, host B's scope (its /shop folder) as well: 4 pages split 2 + 2.
    assert.equal(paths.filter((p) => p.startsWith(hostA + '/shop')).length, 2, paths.join());
    assert.equal(paths.filter((p) => p.startsWith(hostB + '/shop')).length, 2, paths.join());
    assert.ok(paths.includes(`${hostA}/shop`) && paths.includes(`${hostB}/shop/product-2.html`), 'both start pages scanned');

    const report = buildReport(config, run.pages, { version: 'test', axeVersion: run.axeVersion, browser: run.browser });
    // One root cause across both hosts: same group, pages named with their host.
    const btn = report.issues.find((g) => g.ruleId === 'button-name')!;
    assert.ok(btn.pages.some((p) => p.startsWith(hostA)) && btn.pages.some((p) => p.startsWith(hostB)));
    assert.match(reportMarkdown(report), new RegExp(`Scope: several start URLs, \`${hostA}/shop \\+ ${hostB}/shop\``));
    assert.ok(renderHtml(report).includes(`${hostA}/<wbr>shop + ${hostB}/<wbr>shop`));
    const prompt = fixPromptMarkdown(report);
    assert.ok(prompt.includes(`npm run -s audit -- <url of ${hostA}/shop with your changes> <url of ${hostB}/shop with your changes> --same-pages`));
  } finally {
    a.server.close();
    b.server.close();
  }
});

test('audits the /shop subtree of the fixture site', { timeout: 120_000 }, async () => {
  const { url, server } = await serveFixtures();
  try {
    const startUrl = `${url}/shop`;
    const config: AuditConfig = {
      startUrl, scope: scopeFromUrl(startUrl), maxPages: 10, concurrency: 2,
      viewport: { width: 1280, height: 800 }, waitMs: 0, timeoutMs: 15000, keepQuery: false,
      tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      keyboardProbe: true, imageInventory: false, imageScreenshots: false, dismissConsent: true,
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
    // "?" explanations: one button per explained issue, one dialog per rule, buttons hidden until JS runs.
    assert.match(html, /<button type="button" class="explain-btn" data-explain="explain-image-alt" aria-haspopup="dialog" hidden>/);
    assert.equal(html.match(/<dialog class="explain" id="explain-image-alt"/g)?.length, 1);

    // fix prompt: every group lands in exactly one MR category, and the prompt is embedded escaped
    const plan = buildFixPlan(report);
    assert.equal(plan.reduce((a, c) => a + c.groups.length, 0), report.issues.length);
    const markdown = fixPromptMarkdown(report, { reportDir: dir });
    for (const g of report.issues) assert.ok(markdown.includes(g.id), `group ${g.id} missing from fix prompt`);
    const withPrompt = renderHtml(report, { fixPrompt: { markdown, plan } });
    assert.match(withPrompt, /id="fix-prompt"/);
    assert.ok(!withPrompt.includes('<button class="icon-btn"></button>'), 'fix prompt must be escaped too');
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------------ authenticated audits

const baseConfig = (startUrl: string): AuditConfig => ({
  startUrl, scope: scopeFromUrl(startUrl), maxPages: 10, concurrency: 2,
  viewport: { width: 1280, height: 800 }, waitMs: 0, timeoutMs: 15000, keepQuery: false,
  tags: ['wcag2a', 'wcag2aa'], keyboardProbe: false, imageInventory: false, imageScreenshots: false, dismissConsent: false,
});

test('login saves a session, and a logged-in audit crawls the account without logging out', { timeout: 120_000 }, async () => {
  const { url, server } = await serveFixtures();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'dd-auth-'));
    const stateFile = join(dir, 'auth', 'session.json');
    const saved = await captureSession({
      url: `${url}/account`,
      out: stateFile,
      headless: true,
      timeoutMs: 30_000,
      interact: async (page) => {
        await page.waitForURL(/\/login/);
        await page.fill('#email', 'jane@example.test');
        await page.fill('#pw', 'not-a-real-password');
        await page.click('button[type=submit]');
      },
    });
    assert.equal(saved.reason, 'back on the site after logging in');
    assert.match(saved.finalUrl, /\/account\/home$/);
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.ok(state.cookies.some((c: { name: string }) => c.name === 'dd_session'));
    assert.ok(!JSON.stringify(state).includes('not-a-real-password'), 'credentials must never be saved');

    const startUrl = `${url}/account`;
    const config: AuditConfig = {
      ...baseConfig(startUrl),
      imageInventory: true, // the CLI default with --auth: inventory on, screenshots off
      exclude: [LOGOUT_URL.source],
      auth: { stateFile, loggedInCheck: '#account-menu' },
    };
    const run = await runAudit(config, dir, () => {});
    // "/account" is routed client-side to "/account/home", which other pages also link to: scanned once
    assert.deepEqual(run.pages.map((p) => [p.path, p.status]), [['/account/home', 'ok'], ['/account/invoices.html', 'ok']]);
    assert.equal(run.pages[0].redirectedFrom, `${url}/account`);
    assert.equal(run.stopped, undefined);
    // images are inventoried when logged in, but not screenshotted (personal data)
    assert.deepEqual(run.pages[1].images?.map((i) => [i.alt, i.screenshot]), [['Invoice logo', undefined]]);
    await assert.rejects(stat(join(dir, 'assets')), 'no screenshot folder for a logged-in audit');

    const report = buildReport(config, run.pages, { version: 'test', axeVersion: run.axeVersion, browser: run.browser });
    assert.equal(report.summary.pagesAuthLost, 0);
    assert.ok(report.issues.some((g) => g.ruleId === 'image-alt'));
    assert.ok(!JSON.stringify(report).includes('dd_session'), 'session content must not leak into the report');
    assert.match(renderHtml(report), /Logged-in audit/);
    assert.match(renderHtml(report), /id="images-h"[\s\S]*Invoice logo/);
    assert.match(reportMarkdown(report), /Logged-in audit/);
    assert.match(fixPromptMarkdown(report), /--auth <session file for that site> --no-images --logged-in-check '#account-menu'/);

    // the same scope audited logged out is not comparable
    const anon = buildReport(baseConfig(startUrl), run.pages, { version: 'test', axeVersion: run.axeVersion, browser: run.browser });
    const d = diffReports(anon, report);
    assert.equal(d.comparable, false);
    assert.ok(d.warnings.some((w) => /login state differs/.test(w)));
  } finally {
    server.close();
  }
});

test('an expired session is reported as auth-lost and stops the crawl', { timeout: 60_000 }, async () => {
  const { url, server } = await serveFixtures();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'dd-auth-'));
    const stateFile = join(dir, 'empty.json');
    await writeFile(stateFile, JSON.stringify({ cookies: [], origins: [] }));
    const startUrl = `${url}/account`;
    const config: AuditConfig = { ...baseConfig(startUrl), exclude: [LOGOUT_URL.source], auth: { stateFile } };
    const run = await runAudit(config, dir, () => {});
    assert.equal(run.pages.length, 1);
    assert.equal(run.pages[0].status, 'auth-lost');
    assert.match(run.pages[0].error ?? '', /login page .*\/login/);
    assert.match(run.stopped ?? '', /session lost/);
    const report = buildReport(config, run.pages, { version: 'test', axeVersion: run.axeVersion, browser: run.browser, stopped: run.stopped });
    assert.equal(report.summary.pagesScanned, 0);
    assert.equal(report.summary.pagesAuthLost, 1);
    assert.match(renderHtml(report), /Crawl stopped early/);
  } finally {
    server.close();
  }
});

test('a page that redirects to an already-scanned page is skipped as a duplicate', { timeout: 60_000 }, async () => {
  const { url, server } = await serveFixtures();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'dd-dup-'));
    const stateFile = join(dir, 's.json');
    const host = new URL(url).hostname;
    await writeFile(stateFile, JSON.stringify({ cookies: [{ name: 'dd_session', value: 'ok', domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));
    // fixed order: the target first, then the URL that redirects to it
    const config: AuditConfig = {
      ...baseConfig(`${url}/account`),
      concurrency: 1,
      maxPages: 2,
      auth: { stateFile },
      fixedPages: [`${url}/account/home`, `${url}/account`, `${url}/account/invoices.html`],
    };
    const run = await runAudit(config, dir, () => {});
    const byPath = Object.fromEntries(run.pages.map((p) => [p.path, p]));
    assert.equal(byPath['/account/home'].status, 'ok');
    assert.equal(byPath['/account'].status, 'skipped');
    assert.match(byPath['/account'].error ?? '', /same page as \/account\/home/);
    // the duplicate does not use up the page budget: invoices is still scanned with maxPages 2
    assert.equal(byPath['/account/invoices.html']?.status, 'ok');
  } finally {
    server.close();
  }
});

test('batch: audits each entry into its own history and lists them in batch.json', { timeout: 180_000 }, async () => {
  const { url, server } = await serveFixtures();
  try {
    const { parseBatchFile, resolveEntries, runBatch, applySamePagesFrom } = await import('../src/batch.ts');
    const file = parseBatchFile(`base: ${url}\n/shop Shop\n/nowhere\nhttp://127.0.0.1:1/ Unreachable\n`, 'fixture.txt');
    const entries = resolveEntries(file, { maxPages: 3, waitMs: 0, timeoutMs: 5000, skipImages: true });
    const out = await mkdtemp(join(tmpdir(), 'dd-batch-'));
    const { batchDir, batch } = await runBatch({ name: 'fixture', source: 'fixture.txt', entries, imageScreenshots: { loggedOut: false, loggedIn: false }, out, log: () => {}, parallel: 2 });

    assert.ok(batchDir.startsWith(join(out, '_batches', 'fixture')));
    const saved = JSON.parse(await readFile(join(batchDir, 'batch.json'), 'utf8'));
    assert.equal(saved.complete, true);
    assert.deepEqual(saved, JSON.parse(JSON.stringify(batch)));
    const index = await readFile(join(batchDir, 'index.html'), 'utf8');
    assert.ok(index.includes(`href="${batch.entries[0].reportDir}/report.html"`), 'index.html links each entry to its report');
    assert.match(await readFile(join(batchDir, 'index.md'), 'utf8'), /\| \[Shop\]\(/);
    assert.deepEqual(batch.entries.map((e) => e.label), ['Shop', `${url.replace('http://', '')}/nowhere`, 'Unreachable']);

    const shop = batch.entries[0];
    assert.equal(shop.status, 'ok');
    assert.equal(shop.pagesScanned, 3);
    assert.ok(shop.score!.overall > 0 && shop.score!.overall < 100);
    assert.ok(shop.topIssue && shop.topIssue.estimatedScoreGain > 0);
    const report = JSON.parse(await readFile(join(batchDir, shop.reportDir!, 'report.json'), 'utf8'));
    assert.equal(report.summary.score.overall, shop.score!.overall, 'reportDir is relative to the batch folder');
    assert.match(shop.reportDir!, /^\.\.\/\.\.\/\.\.\/127\.0\.0\.1_\d+_shop\//, 'entries keep their usual reports/<slug>/ history');

    assert.notEqual(batch.entries[2].status, 'ok', 'an unreachable site is not scored');
    for (const e of batch.entries.filter((e) => e.status === 'no-pages')) assert.equal(e.score, undefined, 'no page, no score');
    assert.equal(batch.entries[1].status, 'no-pages', 'a 404 start page scans nothing');
    assert.equal(batch.summary.entries, 3);
    assert.equal(batch.summary.min, Math.min(...batch.entries.filter((e) => e.status === 'ok').map((e) => e.score!.overall)));
    assert.equal(batch.previous, undefined, 'first batch of this name');

    // Second run of the same batch name, with one entry: compared with the first, entry by entry.
    const again = resolveEntries(parseBatchFile(`base: ${url}\n/shop Shop\n`, 'fixture.txt'), { maxPages: 3, waitMs: 0, timeoutMs: 5000, skipImages: true });
    const { warnings } = await applySamePagesFrom(again, 'latest', { out, name: 'fixture' });
    assert.deepEqual(warnings, []);
    assert.equal(again[0].options.samePages, join(batchDir, shop.reportDir!, 'report.json'));
    await new Promise((r) => setTimeout(r, 1100)); // batch folders are per second
    const second = await runBatch({ name: 'fixture', source: 'fixture.txt', entries: again, imageScreenshots: { loggedOut: false, loggedIn: false }, out, log: () => {} });
    assert.equal(second.batch.previous?.dir, join('..', batchDir.split('/').pop()!));
    assert.deepEqual(second.batch.previous?.removed, [batch.entries[1].label, 'Unreachable']);
    assert.deepEqual(second.batch.entries[0].sincePrevious, { before: shop.score!.overall, delta: 0, comparable: true, fixed: 0, introduced: 0 });
  } finally {
    server.close();
  }
});
