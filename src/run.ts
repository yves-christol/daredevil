import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { AssistedFinding, AuditConfig, Report } from './types.ts';
import { outermost, scopeConflicts, scopeFromUrl, scopesLabel, scopesOf, scopeText } from './crawl.ts';
import { WCAG_TAGS } from './wcag.ts';
import { runAudit } from './audit.ts';
import { buildReport, diffReports, reportMarkdown, type ReportDiff } from './report.ts';
import { renderHtml } from './html.ts';
import { buildFixPlan, fixPromptMarkdown } from './fixprompt.ts';
import { LOGOUT_URL, loadAuthState, sessionLifetime } from './auth.ts';

export const VERSION = '0.1.0';

/** One audit's options, already parsed (from the command line, or from a batch entry). */
export interface AuditOptions {
  /** One or more start URLs. Several make one combined audit (and report) of all their scopes. */
  startUrls: string[];
  maxPages: number;
  concurrency: number;
  viewport: { width: number; height: number };
  waitMs: number;
  timeoutMs: number;
  userAgent?: string;
  keepQuery: boolean;
  /** Path of a previous report.json whose pages are re-scanned exactly. */
  samePages?: string;
  skipBestPractice: boolean;
  skipKeyboard: boolean;
  keepConsent: boolean;
  consentSelector?: string;
  skipImages: boolean;
  exclude: string[];
  /** Session file saved by `daredevil login`. */
  auth?: string;
  loggedInCheck?: string;
  /** Decided by the caller (logged in: the user's explicit choice). Ignored with skipImages. */
  imageScreenshots: boolean;
  /** Reports root. */
  out: string;
}

/** The options a batch file may set (per entry or as defaults): everything but the URL, screenshots and output. */
export type AuditSettings = Omit<AuditOptions, 'startUrls' | 'imageScreenshots' | 'out'>;

export const DEFAULT_AUDIT_SETTINGS: AuditSettings = {
  maxPages: 25,
  concurrency: 2,
  viewport: { width: 1280, height: 800 },
  waitMs: 1000,
  timeoutMs: 30000,
  keepQuery: false,
  skipBestPractice: false,
  skipKeyboard: false,
  keepConsent: false,
  skipImages: false,
  exclude: [],
};

export interface AuditResult {
  reportDir: string;
  report: Report;
  diff?: ReportDiff;
}

type Log = (m: string) => void;

export const withScheme = (url: string) => (/^https?:\/\//.test(url) ? url : 'https://' + url);

export function parseViewport(v: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`viewport: expected <width>x<height>, e.g. 1280x800, got: ${v}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * Checks that need no browser: start URLs (valid, no scope twice or inside another), --exclude
 * patterns, and the session file (present, not expired for any start URL).
 * Throws on the first problem. Returns the session description for logged-in audits.
 */
export async function checkAuditOptions(o: Pick<AuditOptions, 'startUrls' | 'exclude' | 'auth'>): Promise<{ session?: string }> {
  if (o.startUrls.length === 0) throw new Error('missing start URL');
  for (const u of o.startUrls) {
    try {
      new URL(u);
    } catch {
      throw new Error(`not a valid URL: ${u}`);
    }
  }
  const conflicts = scopeConflicts(o.startUrls);
  if (conflicts.length) throw new Error(conflicts.join('\n'));
  for (const e of o.exclude) {
    try {
      new RegExp(e);
    } catch {
      throw new Error(`--exclude: invalid regular expression: ${e}`);
    }
  }
  if (!o.auth) return {};
  const state = await loadAuthState(o.auth);
  const lives = o.startUrls.map((u) => ({ url: u, life: sessionLifetime(state, u) }));
  const lost = lives.find((x) => x.life.expired);
  if (lost) throw new Error(`session in ${o.auth}: ${lost.life.text}\nLog in again with: npm run -s login -- ${lost.url}`);
  return { session: lives[0].life.text };
}

/** Build the AuditConfig: follows the start URLs' redirects (logged out only), loads --same-pages. */
export async function buildAuditConfig(o: AuditOptions, log: Log): Promise<AuditConfig> {
  const startUrls: string[] = [];
  for (const url of o.startUrls) {
    let startUrl = url;
    // Follow redirects (e.g. mysite.com -> www.mysite.com) so the scope matches real URLs.
    // Not when logged in: this request carries no session, so it would follow the login redirect.
    if (!o.auth)
      try {
        const res = await fetch(startUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
        if (res.url && res.url !== startUrl) {
          log(`start URL ${url} redirects to ${res.url}`);
          startUrl = res.url;
        }
      } catch {
        /* let the browser report the failure */
      }
    startUrls.push(startUrl);
  }
  // Redirects can make two scopes the same, or one inside another: keep the first / the outer one.
  const kept = outermost(startUrls);
  for (const [i, u] of startUrls.entries())
    if (!kept.includes(u) || startUrls.indexOf(u) !== i) log(`${o.startUrls[i]}: after redirects, another start URL already covers its scope; not used`);

  let fixedPages: string[] | undefined;
  if (o.samePages) {
    const prev: Report = JSON.parse(await readFile(o.samePages, 'utf8'));
    fixedPages = prev.pages.filter((p) => p.status === 'ok').map((p) => p.url);
  }
  if (o.loggedInCheck && !o.auth) log('--logged-in-check is ignored without --auth');
  return {
    startUrl: kept[0],
    scope: scopeFromUrl(kept[0]),
    ...(kept.length > 1 ? { startUrls: kept, scopes: kept.map(scopeFromUrl) } : {}),
    maxPages: Math.max(o.maxPages, fixedPages?.length ?? 0),
    concurrency: o.concurrency,
    viewport: o.viewport,
    waitMs: o.waitMs,
    timeoutMs: o.timeoutMs,
    userAgent: o.userAgent,
    keepQuery: o.keepQuery,
    tags: o.skipBestPractice ? WCAG_TAGS : [...WCAG_TAGS, 'best-practice'],
    keyboardProbe: !o.skipKeyboard,
    dismissConsent: !o.keepConsent,
    consentSelector: o.consentSelector,
    imageInventory: !o.skipImages,
    imageScreenshots: o.skipImages ? false : o.imageScreenshots,
    fixedPages,
    exclude: [...o.exclude, ...(o.auth ? [LOGOUT_URL.source] : [])],
    auth: o.auth ? { stateFile: o.auth, loggedInCheck: o.loggedInCheck } : undefined,
  };
}

/**
 * Folder of a scope's runs. Logged-in runs get their own: diffing them with logged-out runs would
 * be meaningless. Several start URLs: their scopes sorted and joined with "+" (the same set in
 * any order is the same history), shortened with a hash when very long.
 */
export function siteSlug(config: AuditConfig): string {
  const slug = (t: string) => t.replace(/[^a-zA-Z0-9.-]+/g, '_');
  let base = scopesOf(config).map((s) => slug(scopeText(s))).sort().join('+');
  if (base.length > 120) base = base.slice(0, 100) + '_' + createHash('sha1').update(base).digest('hex').slice(0, 8);
  return base + (config.auth ? '_auth' : '');
}

export const timestamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

/** Crawl, score and write report.json / report.md / report.html / fix-prompt.md into reports/<slug>/<stamp>/. */
export async function runSingleAudit(config: AuditConfig, out: string, log: Log): Promise<AuditResult> {
  const siteDir = join(out, siteSlug(config));
  const stamp = timestamp();
  const reportDir = join(siteDir, stamp);
  await mkdir(reportDir, { recursive: true });

  const previous = await previousReport(siteDir, stamp);

  log(`Auditing ${scopesLabel(config)} (max ${config.maxPages} pages${config.scopes ? ', shared between the start URLs' : ''})`);
  const run = await runAudit(config, reportDir, log);
  const report = buildReport(config, run.pages, { version: VERSION, axeVersion: run.axeVersion, browser: run.browser, stopped: run.stopped });
  const diff = previous ? diffReports(previous, report) : undefined;

  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  const fixPrompt = await writeFixPrompt(report, reportDir);
  await writeFile(join(reportDir, 'report.md'), reportMarkdown(report, diff));
  await writeFile(join(reportDir, 'report.html'), renderHtml(report, { diff, fixPrompt }));
  return { reportDir, report, diff };
}

/** The JSON printed after an audit. */
export function auditSummary({ reportDir, report, diff }: AuditResult) {
  const s = report.summary;
  return {
    reportDir,
    score: s.score.overall,
    delta: diff?.overall.delta,
    comparableWithPrevious: diff?.comparable,
    pagesScanned: s.pagesScanned,
    pagesFailed: s.pagesFailed,
    ...(report.config.auth ? { pagesAuthLost: s.pagesAuthLost } : {}),
    ...(s.stopped ? { stopped: s.stopped } : {}),
    issueGroups: s.violations.groups,
    violationNodes: s.violations.nodes,
    fixPrompt: join(reportDir, 'fix-prompt.md'),
  };
}

/** Write fix-prompt.md (one merge request per category) and return it for the HTML report. */
export async function writeFixPrompt(report: Report, dir: string, findings?: AssistedFinding[], handoffMd?: string) {
  const markdown = fixPromptMarkdown(report, {
    findings,
    handoffMd,
    reportDir: resolve(dir),
    toolDir: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  });
  await writeFile(join(dir, 'fix-prompt.md'), markdown);
  return { markdown, plan: buildFixPlan(report, findings) };
}

/** The report.json run just before `stamp` for the same site/scope, if any. */
export async function previousReport(siteDir: string, stamp: string): Promise<Report | undefined> {
  if (!existsSync(siteDir)) return undefined;
  const dirs = (await readdir(siteDir)).filter((d) => d < stamp && existsSync(join(siteDir, d, 'report.json'))).sort();
  const last = dirs.at(-1);
  return last ? JSON.parse(await readFile(join(siteDir, last, 'report.json'), 'utf8')) : undefined;
}
