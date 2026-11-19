#!/usr/bin/env -S npx tsx
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import type { AuditConfig, Report } from './types.ts';
import { scopeFromUrl } from './crawl.ts';
import { runAudit } from './audit.ts';
import { buildReport, diffMarkdown, diffReports, reportMarkdown } from './report.ts';
import { renderHtml, type HtmlExtras } from './html.ts';
import { buildFixPlan, fixPromptMarkdown } from './fixprompt.ts';
import type { AssistedFinding } from './types.ts';

const VERSION = '0.1.0';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const USAGE = `daredevil — accessibility audit (axe-core + Playwright)

Usage:
  daredevil audit <url> [options]     Crawl pages under <url>'s path and audit them
  daredevil diff <before.json> <after.json>
  daredevil render <reportDir>        Rebuild report.md / report.html / fix-prompt.md, including the
                                      agent's summary.md, assisted.json and handoff.md if present

Audit options:
  --max-pages <n>        Max pages to scan (default 25)
  --concurrency <n>      Parallel pages (default 2)
  --viewport <WxH>       Viewport (default 1280x800)
  --wait-ms <ms>         Extra settle time after load (default 1000)
  --timeout <ms>         Navigation timeout (default 30000)
  --user-agent <ua>      Override the browser user agent
  --keep-query           Treat ?query variants as distinct pages
  --same-pages <json>    Re-scan exactly the pages of a previous report.json (strict comparison)
  --skip-best-practice   Do not run axe best-practice rules
  --keep-consent         Do not dismiss cookie-consent dialogs (audit them as shown)
  --consent-selector <s> CSS selector of the consent 'reject' button, if not auto-detected
  --skip-keyboard        Skip the keyboard probe
  --skip-images          Skip image screenshots for alt-text review
  --out <dir>            Reports root (default ./reports)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'audit') return audit(rest);
  if (cmd === 'diff') return diff(rest);
  if (cmd === 'render') return render(rest);
  process.stdout.write(USAGE);
  process.exit(cmd ? 1 : 0);
}

async function audit(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h')) return void process.stdout.write(USAGE);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'max-pages': { type: 'string', default: '25' },
      concurrency: { type: 'string', default: '2' },
      viewport: { type: 'string', default: '1280x800' },
      'wait-ms': { type: 'string', default: '1000' },
      timeout: { type: 'string', default: '30000' },
      'keep-query': { type: 'boolean', default: false },
      'user-agent': { type: 'string' },
      'same-pages': { type: 'string' },
      'skip-best-practice': { type: 'boolean', default: false },
      'skip-keyboard': { type: 'boolean', default: false },
      'keep-consent': { type: 'boolean', default: false },
      'consent-selector': { type: 'string' },
      'skip-images': { type: 'boolean', default: false },
      out: { type: 'string', default: 'reports' },
    },
  });
  let startUrl = positionals[0];
  if (!startUrl) throw new Error('missing <url>\n\n' + USAGE);
  if (!/^https?:\/\//.test(startUrl)) startUrl = 'https://' + startUrl;

  // Follow redirects (e.g. mysite.com -> www.mysite.com) so the scope matches real URLs.
  try {
    const res = await fetch(startUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (res.url && res.url !== startUrl) {
      console.error(`start URL redirects to ${res.url}`);
      startUrl = res.url;
    }
  } catch {
    /* let the browser report the failure */
  }

  const [w, h] = values.viewport!.split('x').map(Number);
  let fixedPages: string[] | undefined;
  if (values['same-pages']) {
    const prev: Report = JSON.parse(await readFile(values['same-pages'], 'utf8'));
    fixedPages = prev.pages.filter((p) => p.status === 'ok').map((p) => p.url);
  }
  const config: AuditConfig = {
    startUrl,
    scope: scopeFromUrl(startUrl),
    maxPages: Math.max(Number(values['max-pages']), fixedPages?.length ?? 0),
    concurrency: Number(values.concurrency),
    viewport: { width: w, height: h },
    waitMs: Number(values['wait-ms']),
    timeoutMs: Number(values.timeout),
    userAgent: values['user-agent'],
    keepQuery: values['keep-query']!,
    tags: values['skip-best-practice'] ? WCAG_TAGS : [...WCAG_TAGS, 'best-practice'],
    keyboardProbe: !values['skip-keyboard'],
    dismissConsent: !values['keep-consent'],
    consentSelector: values['consent-selector'],
    imageCapture: !values['skip-images'],
    fixedPages,
  };

  const slug = (config.scope.origin.replace(/^https?:\/\//, '') + config.scope.pathPrefix).replace(/[^a-zA-Z0-9.-]+/g, '_');
  const siteDir = join(values.out!, slug);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const reportDir = join(siteDir, stamp);
  await mkdir(reportDir, { recursive: true });

  const previous = await previousReport(siteDir, stamp);

  console.error(`Auditing ${config.scope.origin}${config.scope.pathPrefix || '/'} (max ${config.maxPages} pages)`);
  const run = await runAudit(config, reportDir, (m) => console.error(m));
  const report = buildReport(config, run.pages, { version: VERSION, axeVersion: run.axeVersion, browser: run.browser });
  const d = previous ? diffReports(previous, report) : undefined;

  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  const fixPrompt = await writeFixPrompt(report, reportDir);
  await writeFile(join(reportDir, 'report.md'), reportMarkdown(report, d));
  await writeFile(join(reportDir, 'report.html'), renderHtml(report, { diff: d, fixPrompt }));

  const s = report.summary;
  console.log(
    JSON.stringify(
      {
        reportDir,
        score: s.score.overall,
        delta: d?.overall.delta,
        comparableWithPrevious: d?.comparable,
        pagesScanned: s.pagesScanned,
        pagesFailed: s.pagesFailed,
        issueGroups: s.violations.groups,
        violationNodes: s.violations.nodes,
        fixPrompt: join(reportDir, 'fix-prompt.md'),
      },
      null,
      2,
    ),
  );
}

/** Write fix-prompt.md (one merge request per category) and return it for the HTML report. */
async function writeFixPrompt(report: Report, dir: string, findings?: AssistedFinding[], handoffMd?: string) {
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
async function previousReport(siteDir: string, stamp: string): Promise<Report | undefined> {
  if (!existsSync(siteDir)) return undefined;
  const dirs = (await readdir(siteDir)).filter((d) => d < stamp && existsSync(join(siteDir, d, 'report.json'))).sort();
  const last = dirs.at(-1);
  return last ? JSON.parse(await readFile(join(siteDir, last, 'report.json'), 'utf8')) : undefined;
}

async function diff(argv: string[]) {
  const [a, b] = argv;
  if (!a || !b) throw new Error('usage: daredevil diff <before.json> <after.json>');
  const ra: Report = JSON.parse(await readFile(a, 'utf8'));
  const rb: Report = JSON.parse(await readFile(b, 'utf8'));
  process.stdout.write(diffMarkdown(diffReports(ra, rb)) + '\n');
}

/** Re-render report.md and report.html, folding in the agent's deliverables if present. */
async function render(argv: string[]) {
  const dir = argv[0];
  if (!dir || !existsSync(join(dir, 'report.json'))) throw new Error('usage: daredevil render <reportDir containing report.json>');
  const report: Report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  const previous = await previousReport(dirname(dir), basename(dir));
  const extras: HtmlExtras = { diff: previous ? diffReports(previous, report) : undefined };
  const opt = async (f: string) => (existsSync(join(dir, f)) ? readFile(join(dir, f), 'utf8') : undefined);
  const assisted = await opt('assisted.json');
  if (assisted) {
    try {
      extras.assisted = JSON.parse(assisted);
    } catch (e) {
      console.error(`assisted.json is not valid JSON, skipped: ${(e as Error).message}`);
    }
  }
  extras.summaryMd = await opt('summary.md');
  const handoffMd = await opt('handoff.md');
  extras.hasHandoff = handoffMd !== undefined;
  extras.fixPrompt = await writeFixPrompt(report, dir, extras.assisted?.findings, handoffMd);
  await writeFile(join(dir, 'report.md'), reportMarkdown(report, extras.diff));
  await writeFile(join(dir, 'report.html'), renderHtml(report, extras));
  console.log(join(dir, 'report.html'));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
