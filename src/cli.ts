#!/usr/bin/env -S npx tsx
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, join } from 'node:path';
import type { Report } from './types.ts';
import { diffMarkdown, diffReports, reportMarkdown } from './report.ts';
import { renderHtml, type HtmlExtras } from './html.ts';
import { captureSession, defaultStateFile } from './auth.ts';
import { auditSummary, buildAuditConfig, checkAuditOptions, parseViewport, previousReport, runSingleAudit, withScheme, writeFixPrompt } from './run.ts';

const USAGE = `daredevil — accessibility audit (axe-core + Playwright)

Usage:
  daredevil audit <url> [options]     Crawl pages under <url>'s path and audit them
  daredevil login <url> [options]     Open a browser, let you log in, save the session for --auth
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
  --skip-images          Skip the image inventory (alt texts and screenshots) for alt-text review
  --exclude <regex>      Never visit URLs matching this (case-insensitive; repeatable)
  --auth <file>          Audit logged in, with a session saved by 'daredevil login'. Logout and
                         account-changing links are excluded, pages that land on a login page are marked auth-lost, and
                         the crawl stops after 2 in a row. Screenshots of images can show personal
                         data, so you are asked whether to take them (or pass --images / --no-images);
                         the alt-text inventory is collected either way
  --logged-in-check <s>  CSS selector visible only when logged in (stricter session check)
  --images               With --auth: take image screenshots (you accept they may show personal data)
  --no-images            No image screenshots (alt-text inventory only)
  --out <dir>            Reports root (default ./reports)

Login options:
  --out <file>           Session file (default .auth/<host>.json, git-ignored, mode 0600)
  --logged-in-check <s>  Save as soon as this selector is visible
  --wait <minutes>       Give up after this long (default 10)

  You log in yourself, in a visible browser window; daredevil never sees your credentials.
  The session is saved once you are back on the site after logging in (or press Enter /
  close the window).
`;

/**
 * Whether to screenshot images. Logged out: yes unless --no-images. Logged in, screenshots can
 * show personal data from the account, so it is the user's decision: --images / --no-images, or
 * an explicit question in a terminal. Without a terminal (e.g. run by an agent) we refuse to guess.
 */
async function screenshotChoice(loggedIn: boolean, yes: boolean, no: boolean): Promise<boolean> {
  if (yes && no) throw new Error('--images and --no-images are mutually exclusive');
  if (yes || no) return yes;
  if (!loggedIn) return true;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      'logged-in audit: decide whether images may be screenshotted. Screenshots of account pages can show personal data\n' +
        '(names, photos, documents) and are saved in the report. Re-run with --images (take them) or --no-images (alt-text\n' +
        'inventory only).',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl
      .question(
        'Logged-in audit: take screenshots of the images for the alt-text review?\n' +
          'They are saved in the report and can show personal data from the account (names, photos, documents).\n' +
          'Without them, alt texts are still listed and reviewed from text only. Take screenshots? [y/N] ',
      )
      .catch(() => ''); // Ctrl+D / closed input: no
    return /^\s*(y|yes|o|oui)\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'audit') return audit(rest);
  if (cmd === 'login') return login(rest);
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
      exclude: { type: 'string', multiple: true },
      auth: { type: 'string' },
      'logged-in-check': { type: 'string' },
      images: { type: 'boolean', default: false },
      'no-images': { type: 'boolean', default: false },
      out: { type: 'string', default: 'reports' },
    },
  });
  if (!positionals[0]) throw new Error('missing <url>\n\n' + USAGE);
  const startUrl = withScheme(positionals[0]);
  const authFile = values.auth;
  const exclude = values.exclude ?? [];
  const { session } = await checkAuditOptions({ startUrl, exclude, auth: authFile });
  if (session) console.error(`session: ${session}`);
  const imageScreenshots = values['skip-images'] ? false : await screenshotChoice(!!authFile, values.images!, values['no-images']!);

  const log = (m: string) => console.error(m);
  const config = await buildAuditConfig(
    {
      startUrl,
      maxPages: Number(values['max-pages']),
      concurrency: Number(values.concurrency),
      viewport: parseViewport(values.viewport!),
      waitMs: Number(values['wait-ms']),
      timeoutMs: Number(values.timeout),
      userAgent: values['user-agent'],
      keepQuery: values['keep-query']!,
      samePages: values['same-pages'],
      skipBestPractice: values['skip-best-practice']!,
      skipKeyboard: values['skip-keyboard']!,
      keepConsent: values['keep-consent']!,
      consentSelector: values['consent-selector'],
      skipImages: values['skip-images']!,
      exclude,
      auth: authFile,
      loggedInCheck: values['logged-in-check'],
      imageScreenshots,
      out: values.out!,
    },
    log,
  );
  const result = await runSingleAudit(config, values.out!, log);
  console.log(JSON.stringify(auditSummary(result), null, 2));
}

async function login(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h')) return void process.stdout.write(USAGE);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'logged-in-check': { type: 'string' },
      wait: { type: 'string', default: '10' },
      headless: { type: 'boolean', default: false },
    },
  });
  if (!positionals[0]) throw new Error('missing <url>\n\n' + USAGE);
  const url = withScheme(positionals[0]);
  const out = values.out ?? defaultStateFile(url);
  console.error(`Opening ${url} in a browser window.`);
  const res = await captureSession({
    url,
    out,
    loggedInCheck: values['logged-in-check'],
    headless: values.headless,
    timeoutMs: Number(values.wait) * 60_000,
    log: (m) => console.error(m),
  });
  console.error(`Saved session (${res.reason}) to ${res.file}: ${res.lifetime}.`);
  console.error(`This file gives access to the account: keep it private. Delete it when done.`);
  console.log(JSON.stringify({ sessionFile: res.file, finalUrl: res.finalUrl, saved: res.reason, lifetime: res.lifetime, audit: `npm run -s audit -- ${url} --auth ${res.file}` }, null, 2));
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
