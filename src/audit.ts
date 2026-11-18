import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import type { AxeResults, Result as AxeResult } from 'axe-core';
import type { AuditConfig, Impact, PageResult, RuleResult } from './types.ts';
import { inScope, normalizeUrl, pathOf } from './crawl.ts';
import { groupId, nodeSignature } from './group.ts';
import { levelOf, principleOf, successCriteria } from './wcag.ts';
import { imageInventory, keyboardProbe } from './probes.ts';

export interface AuditRun {
  pages: PageResult[];
  axeVersion: string;
  browser: string;
}

type Log = (msg: string) => void;

export async function runAudit(config: AuditConfig, reportDir: string, log: Log): Promise<AuditRun> {
  const assetDir = `${reportDir}/assets`;
  if (config.imageCapture) await mkdir(assetDir, { recursive: true });

  const browser = await chromium.launch();
  if (!config.userAgent) {
    const probe = await browser.newPage();
    const ua = await probe.evaluate(() => navigator.userAgent);
    await probe.close();
    config.userAgent = ua.replace('HeadlessChrome', 'Chrome') + ' daredevil-a11y/0.1';
  }
  const queue: string[] = [];
  const seen = new Set<string>();
  const pages: PageResult[] = [];
  let axeVersion = 'unknown';

  const enqueue = (raw: string) => {
    const u = normalizeUrl(raw, config.keepQuery);
    if (!u || seen.has(u) || !inScope(u, config.scope)) return;
    seen.add(u);
    queue.push(u);
  };

  const fixed = config.fixedPages !== undefined;
  if (fixed) for (const u of config.fixedPages!) enqueue(u);
  else enqueue(config.startUrl);

  let started = 0;
  const worker = async () => {
    while (queue.length > 0 && started < config.maxPages) {
      const url = queue.shift()!;
      const index = started++;
      log(`[${index + 1}] ${url}`);
      const { result, links, version } = await scanPage(browser, url, index, config, assetDir);
      if (version) axeVersion = version;
      pages.push(result);
      if (result.status !== 'ok') log(`    ${result.status}: ${result.error}`);
      if (!fixed) for (const l of links) enqueue(l);
    }
  };

  // Workers poll the queue; restart them while the crawl keeps discovering pages.
  while (queue.length > 0 && started < config.maxPages) {
    await Promise.all(Array.from({ length: config.concurrency }, worker));
  }

  const browserVersion = `chromium ${browser.version()}`;
  await browser.close();
  // Stable order regardless of concurrency timing.
  pages.sort((a, b) => a.url.localeCompare(b.url));
  return { pages, axeVersion, browser: browserVersion };
}

async function scanPage(
  browser: Browser,
  url: string,
  index: number,
  config: AuditConfig,
  assetDir: string,
): Promise<{ result: PageResult; links: string[]; version?: string }> {
  const base: PageResult = { url, path: pathOf(url), status: 'ok', violations: [], incomplete: [], passes: [] };
  const context = await browser.newContext({ viewport: config.viewport, reducedMotion: 'reduce', userAgent: config.userAgent });
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: config.timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    if (config.waitMs > 0) await page.waitForTimeout(config.waitMs);

    const finalUrl = normalizeUrl(page.url(), config.keepQuery) ?? url;
    base.httpStatus = resp?.status();
    base.title = await page.title();
    const ctype = resp?.headers()['content-type'] ?? 'text/html';
    if (!ctype.includes('html')) return { result: { ...base, status: 'skipped', error: `content-type ${ctype}` }, links: [] };
    if (finalUrl !== url && !inScope(finalUrl, config.scope)) {
      return { result: { ...base, status: 'skipped', error: `redirected out of scope to ${finalUrl}` }, links: [] };
    }
    if (resp && resp.status() >= 400) return { result: { ...base, status: 'error', error: `HTTP ${resp.status()}` }, links: [] };

    const links = await page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).href));
    const axe: AxeResults = await new AxeBuilder({ page }).withTags(config.tags).analyze();

    const result: PageResult = {
      ...base,
      violations: axe.violations.map(toRule),
      incomplete: axe.incomplete.map(toRule),
      passes: axe.passes.map((r) => ({ ruleId: r.id, nodeCount: r.nodes.length })),
    };
    const probeError = (name: string) => (e: Error) => {
      (result.probeErrors ??= []).push(`${name}: ${e.message.split('\n')[0]}`);
      return undefined;
    };
    if (config.keyboardProbe) result.keyboard = await keyboardProbe(page).catch(probeError('keyboard'));
    if (config.imageCapture) {
      const prefix = `p${String(index + 1).padStart(3, '0')}-${createHash('sha1').update(url).digest('hex').slice(0, 6)}`;
      result.images = await imageInventory(page, assetDir, prefix).catch(probeError('images'));
    }
    return { result, links, version: axe.testEngine.version };
  } catch (e) {
    return { result: { ...base, status: 'error', error: (e as Error).message.split('\n')[0] }, links: [] };
  } finally {
    await context.close();
  }
}

function toRule(r: AxeResult): RuleResult {
  return {
    ruleId: r.id,
    impact: (r.impact ?? null) as Impact | null,
    description: r.description,
    help: r.help,
    helpUrl: r.helpUrl,
    tags: r.tags,
    wcag: successCriteria(r.tags),
    level: levelOf(r.tags),
    principle: principleOf(r.tags),
    nodes: r.nodes.map((n) => {
      // Targets can be nested arrays for iframes / shadow DOM.
      const selector = n.target.map((t) => (Array.isArray(t) ? t.join(' >>> ') : String(t))).join(' >>> ');
      const data = r.id.startsWith('color-contrast') ? pickContrast(n.any[0]?.data) : undefined;
      const signature = nodeSignature(r.id, selector, n.html, data);
      return {
        selector,
        html: n.html.length > 400 ? n.html.slice(0, 400) + '…' : n.html,
        failureSummary: n.failureSummary,
        signature,
        groupId: groupId(r.id, signature),
        data,
      };
    }),
  };
}

function pickContrast(d: unknown): Record<string, unknown> | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const x = d as Record<string, unknown>;
  if (!x.fgColor) return undefined;
  return {
    fgColor: x.fgColor,
    bgColor: x.bgColor,
    contrastRatio: x.contrastRatio,
    expectedContrastRatio: x.expectedContrastRatio,
    fontSize: x.fontSize,
    fontWeight: x.fontWeight,
  };
}
