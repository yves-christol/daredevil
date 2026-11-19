import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { AssistedFinding, AuditConfig, Report } from './types.ts';
import { scopeFromUrl } from './crawl.ts';
import { WCAG_TAGS } from './wcag.ts';
import { runAudit } from './audit.ts';
import { buildReport, diffReports, reportMarkdown, type ReportDiff } from './report.ts';
import { renderHtml } from './html.ts';
import { buildFixPlan, fixPromptMarkdown } from './fixprompt.ts';
import { LOGOUT_URL, loadAuthState, sessionLifetime } from './auth.ts';

export const VERSION = '0.1.0';

/** One audit's options, already parsed (from the command line, or from a batch entry). */
export interface AuditOptions {
  startUrl: string;
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

export interface AuditResult {
  reportDir: string;
  report: Report;
  diff?: ReportDiff;
}

type Log = (m: string) => void;

export const withScheme = (url: string) => (/^https?:\/\//.test(url) ? url : 'https://' + url);

export function parseViewport(v: string): { width: number; height: number } {
  const [width, height] = v.split('x').map(Number);
  return { width, height };
}

/**
 * Checks that need no browser: --exclude patterns, and the session file (present, not expired).
 * Throws on the first problem. Returns the session description for logged-in audits.
 */
export async function checkAuditOptions(o: Pick<AuditOptions, 'startUrl' | 'exclude' | 'auth'>): Promise<{ session?: string }> {
  for (const e of o.exclude) {
    try {
      new RegExp(e);
    } catch {
      throw new Error(`--exclude: invalid regular expression: ${e}`);
    }
  }
  if (!o.auth) return {};
  const state = await loadAuthState(o.auth);
  const life = sessionLifetime(state, o.startUrl);
  if (life.expired) throw new Error(`session in ${o.auth}: ${life.text}\nLog in again with: npm run -s login -- ${o.startUrl}`);
  return { session: life.text };
}

/** Build the AuditConfig: follows the start URL's redirects (logged out only), loads --same-pages. */
export async function buildAuditConfig(o: AuditOptions, log: Log): Promise<AuditConfig> {
  let startUrl = o.startUrl;
  // Follow redirects (e.g. mysite.com -> www.mysite.com) so the scope matches real URLs.
  // Not when logged in: this request carries no session, so it would follow the login redirect.
  if (!o.auth)
    try {
      const res = await fetch(startUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (res.url && res.url !== startUrl) {
        log(`start URL redirects to ${res.url}`);
        startUrl = res.url;
      }
    } catch {
      /* let the browser report the failure */
    }

  let fixedPages: string[] | undefined;
  if (o.samePages) {
    const prev: Report = JSON.parse(await readFile(o.samePages, 'utf8'));
    fixedPages = prev.pages.filter((p) => p.status === 'ok').map((p) => p.url);
  }
  if (o.loggedInCheck && !o.auth) log('--logged-in-check is ignored without --auth');
  return {
    startUrl,
    scope: scopeFromUrl(startUrl),
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

/** Folder of a scope's runs. Logged-in runs get their own: diffing them with logged-out runs would be meaningless. */
export function siteSlug(config: AuditConfig): string {
  return (config.scope.origin.replace(/^https?:\/\//, '') + config.scope.pathPrefix).replace(/[^a-zA-Z0-9.-]+/g, '_') + (config.auth ? '_auth' : '');
}

export const timestamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

/** Crawl, score and write report.json / report.md / report.html / fix-prompt.md into reports/<slug>/<stamp>/. */
export async function runSingleAudit(config: AuditConfig, out: string, log: Log): Promise<AuditResult> {
  const siteDir = join(out, siteSlug(config));
  const stamp = timestamp();
  const reportDir = join(siteDir, stamp);
  await mkdir(reportDir, { recursive: true });

  const previous = await previousReport(siteDir, stamp);

  log(`Auditing ${config.scope.origin}${config.scope.pathPrefix || '/'} (max ${config.maxPages} pages)`);
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
