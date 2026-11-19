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
import { dismissConsent } from './consent.ts';
import { defaultUserAgent, isLoginUrl, loadAuthState, type StorageState } from './auth.ts';

export interface AuditRun {
  pages: PageResult[];
  axeVersion: string;
  browser: string;
  /** Why the crawl stopped before exhausting the queue, if it did. */
  stopped?: string;
}

/** Consecutive `auth-lost` pages after which an authenticated crawl gives up. */
const AUTH_LOST_LIMIT = 2;

/** Shared crawl state for authenticated audits. */
interface AuthSession {
  /** Latest storage state: refreshed after each good page, so rotated session cookies carry over. */
  state: StorageState;
  loggedInCheck?: string;
}

type Log = (msg: string) => void;

export async function runAudit(config: AuditConfig, reportDir: string, log: Log): Promise<AuditRun> {
  const assetDir = `${reportDir}/assets`;
  if (config.imageCapture) await mkdir(assetDir, { recursive: true });

  const auth: AuthSession | undefined = config.auth
    ? { state: await loadAuthState(config.auth.stateFile), loggedInCheck: config.auth.loggedInCheck }
    : undefined;
  const exclude = (config.exclude ?? []).map((e) => new RegExp(e, 'i'));
  const browser = await chromium.launch();
  if (!config.userAgent) config.userAgent = await defaultUserAgent(browser);
  const queue: string[] = [];
  const seen = new Set<string>();
  const pages: PageResult[] = [];
  let axeVersion = 'unknown';
  // Once a consent dialog has been seen, keep waiting for it on every page; if the first
  // page had none, only poll briefly afterwards (saves ~4s per page on sites without one).
  const consentState = { firstChecked: false, seen: false };

  const enqueue = (raw: string) => {
    const u = normalizeUrl(raw, config.keepQuery);
    if (!u || seen.has(u) || !inScope(u, config.scope)) return;
    if (exclude.some((re) => re.test(u))) return;
    seen.add(u);
    queue.push(u);
  };

  const fixed = config.fixedPages !== undefined;
  if (fixed) for (const u of config.fixedPages!) enqueue(u);
  else enqueue(config.startUrl);

  let started = 0;
  let authLostInARow = 0;
  let stopped: string | undefined;
  const worker = async () => {
    while (!stopped && queue.length > 0 && started < config.maxPages) {
      const url = queue.shift()!;
      const index = started++;
      log(`[${index + 1}] ${url}`);
      const { result, links, version } = await scanPage(browser, url, index, config, assetDir, consentState, auth);
      if (version) axeVersion = version;
      pages.push(result);
      if (result.status !== 'ok') log(`    ${result.status}: ${result.error}`);
      if (result.status === 'auth-lost') {
        if (++authLostInARow >= AUTH_LOST_LIMIT || pages.length === 1) {
          stopped ??= `session lost: ${authLostInARow} page${authLostInARow === 1 ? '' : 's'} in a row landed on a login page; log in again with \`npm run -s login -- ${config.startUrl}\``;
        }
      } else if (result.status === 'ok') authLostInARow = 0;
      if (!fixed) for (const l of links) enqueue(l);
    }
  };

  // Workers poll the queue; restart them while the crawl keeps discovering pages.
  while (!stopped && queue.length > 0 && started < config.maxPages) {
    await Promise.all(Array.from({ length: config.concurrency }, worker));
  }

  const browserVersion = `chromium ${browser.version()}`;
  await browser.close();
  // Stable order regardless of concurrency timing.
  pages.sort((a, b) => a.url.localeCompare(b.url));
  if (stopped) log(stopped);
  return { pages, axeVersion, browser: browserVersion, stopped };
}

async function scanPage(
  browser: Browser,
  url: string,
  index: number,
  config: AuditConfig,
  assetDir: string,
  consentState: { firstChecked: boolean; seen: boolean },
  auth?: AuthSession,
): Promise<{ result: PageResult; links: string[]; version?: string }> {
  const base: PageResult = { url, path: pathOf(url), status: 'ok', violations: [], incomplete: [], passes: [] };
  const context = await browser.newContext({
    viewport: config.viewport,
    reducedMotion: 'reduce',
    userAgent: config.userAgent,
    storageState: auth?.state,
  });
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: config.timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    if (config.waitMs > 0) await page.waitForTimeout(config.waitMs);

    const finalUrl = normalizeUrl(page.url(), config.keepQuery) ?? url;
    base.httpStatus = resp?.status();
    base.title = await page.title();
    if (auth) {
      // Logged-out visitors are sent to a login page, often by client-side script after load.
      if (finalUrl !== url && isLoginUrl(page.url(), config.scope.origin)) {
        return { result: { ...base, status: 'auth-lost', error: `redirected to login page ${normalizeUrl(page.url(), false) ?? page.url()}` }, links: [] };
      }
      if (auth.loggedInCheck && !(await page.locator(auth.loggedInCheck).first().isVisible().catch(() => false))) {
        return { result: { ...base, status: 'auth-lost', error: `logged-in check not found: ${auth.loggedInCheck}` }, links: [] };
      }
    }
    const ctype = resp?.headers()['content-type'] ?? 'text/html';
    if (!ctype.includes('html')) return { result: { ...base, status: 'skipped', error: `content-type ${ctype}` }, links: [] };
    if (finalUrl !== url && !inScope(finalUrl, config.scope)) {
      return { result: { ...base, status: 'skipped', error: `redirected out of scope to ${finalUrl}` }, links: [] };
    }
    if (resp && resp.status() >= 400) return { result: { ...base, status: 'error', error: `HTTP ${resp.status()}` }, links: [] };

    let consent: PageResult['consent'];
    if (config.dismissConsent) {
      const wait = !consentState.firstChecked || consentState.seen ? 4000 : 800;
      consent = await dismissConsent(page, config.consentSelector, wait);
      consentState.firstChecked = true;
      if (consent.dismissed) consentState.seen = true;
    }

    const links = await page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).href));
    const axe: AxeResults = await new AxeBuilder({ page }).withTags(config.tags).analyze();

    const result: PageResult = {
      ...base,
      consent,
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
    // Carry rotated session cookies over to the next pages.
    if (auth) auth.state = await context.storageState().catch(() => auth.state);
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
