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
import {
  DEFAULT_AUDIT_SETTINGS,
  auditSummary,
  buildAuditConfig,
  checkAuditOptions,
  parseViewport,
  previousReport,
  runSingleAudit,
  withScheme,
  writeFixPrompt,
} from './run.ts';
import { applySamePagesFrom, batchName, parseBatchFile, preflight, renderBatch, resolveEntries, runBatch, type EntrySettings } from './batch.ts';

const USAGE = `daredevil — accessibility audit (axe-core + Playwright)

Usage:
  daredevil audit <url> [<url>...] [options]
                                      Crawl pages under <url>'s path and audit them. Several URLs
                                      (any hosts): one combined audit, report and score for all
                                      their paths; --max-pages is shared evenly between them
  daredevil batch <file> [options]    Audit every URL or path listed in <file> (.txt or .json), then
                                      write reports/_batches/<name>/<stamp>/ (batch.json, index.html,
                                      index.md: every score, linking to each detailed report)
  daredevil render-batch <batchDir>   Rebuild index.html / index.md, including the agent's summary.md
  daredevil login <url> [options]     Open a browser, let you log in, save the session for --auth
  daredevil diff <before.json> <after.json>
  daredevil render <reportDir>        Rebuild report.md / report.html / fix-prompt.md, including the
                                      agent's summary.md, assisted.json and handoff.md if present

Audit options:
  --max-pages <n>        Max pages to scan (default 25; in total, with several URLs)
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

Batch:
  <file>.txt             One entry per line: <url or /path> [label]. '#' comments, 'base: <url>' to
                         resolve paths, 'name: <name>' for the batch folder (default: the file name).
                         '<url> + <url> + ... [label]': one combined audit of several URLs
  <file>.json            { "name", "base", "defaults": {settings}, "entries": ["/path" |
                         { "url", "label", ...settings }] }. "url" may be an array (one combined
                         audit). Settings use the option names in camelCase (maxPages, exclude,
                         auth, samePages, viewport: "1280x800", ...)
  -                      As <file>: read the list from stdin (JSON if it starts with '{')
  --base <url>           Resolve /paths against this origin (overrides the file's base)
  --name <name>          Batch name (overrides the file's; default: the file name, or 'batch')
  --parallel <n>         Audits run at once (default 1). Never two on the same origin at once: for
                         one site, raise --concurrency (pages in parallel) instead
  --same-pages-from <b>  Re-scan, for each entry, exactly the pages its scope scanned in batch <b>:
                         a batch.json, its folder, or 'latest' (last complete batch of this name).
                         For a strict before/after comparison. An entry's own samePages wins
  Audit options apply to every entry: defaults < file "defaults" < command line < entry settings;
  --exclude patterns add up. A failing entry is recorded and the
  batch goes on. Every entry is checked (URLs, --exclude, sessions) before anything is crawled.
  With logged-in entries, the screenshot question is asked once for the whole batch.

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
  if (cmd === 'batch') return batch(rest);
  if (cmd === 'login') return login(rest);
  if (cmd === 'diff') return diff(rest);
  if (cmd === 'render') return render(rest);
  if (cmd === 'render-batch') return renderBatchCmd(rest);
  process.stdout.write(USAGE);
  process.exit(cmd ? 1 : 0);
}

/** Options shared by `audit` and `batch`. No defaults here: a batch must know which flags were actually passed. */
const AUDIT_ARGS = {
  'max-pages': { type: 'string' },
  concurrency: { type: 'string' },
  viewport: { type: 'string' },
  'wait-ms': { type: 'string' },
  timeout: { type: 'string' },
  'keep-query': { type: 'boolean' },
  'user-agent': { type: 'string' },
  'same-pages': { type: 'string' },
  'skip-best-practice': { type: 'boolean' },
  'skip-keyboard': { type: 'boolean' },
  'keep-consent': { type: 'boolean' },
  'consent-selector': { type: 'string' },
  'skip-images': { type: 'boolean' },
  exclude: { type: 'string', multiple: true },
  auth: { type: 'string' },
  'logged-in-check': { type: 'string' },
  images: { type: 'boolean', default: false },
  'no-images': { type: 'boolean', default: false },
  out: { type: 'string', default: 'reports' },
} as const;

type AuditArgValues = ReturnType<typeof parseArgs<{ args: string[]; options: typeof AUDIT_ARGS; allowPositionals: true }>>['values'];

/** The settings given on the command line, and only those. */
function settingsFromArgs(v: AuditArgValues): EntrySettings {
  const num = (flag: string, x: string | undefined) => {
    if (x === undefined) return undefined;
    const n = Number(x);
    if (x.trim() === '' || !Number.isFinite(n) || n < 0) throw new Error(`--${flag}: expected a non-negative number, got: ${x}`);
    return n;
  };
  const s: EntrySettings = {
    maxPages: num('max-pages', v['max-pages']),
    concurrency: num('concurrency', v.concurrency),
    viewport: v.viewport === undefined ? undefined : parseViewport(v.viewport),
    waitMs: num('wait-ms', v['wait-ms']),
    timeoutMs: num('timeout', v.timeout),
    userAgent: v['user-agent'],
    keepQuery: v['keep-query'],
    samePages: v['same-pages'],
    skipBestPractice: v['skip-best-practice'],
    skipKeyboard: v['skip-keyboard'],
    keepConsent: v['keep-consent'],
    consentSelector: v['consent-selector'],
    skipImages: v['skip-images'],
    exclude: v.exclude,
    auth: v.auth,
    loggedInCheck: v['logged-in-check'],
  };
  return Object.fromEntries(Object.entries(s).filter(([, x]) => x !== undefined)) as EntrySettings;
}

const log = (m: string) => console.error(m);

async function audit(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h')) return void process.stdout.write(USAGE);
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: AUDIT_ARGS });
  if (!positionals[0]) throw new Error('missing <url>\n\n' + USAGE);
  const options = { ...DEFAULT_AUDIT_SETTINGS, ...settingsFromArgs(values), startUrls: positionals.map(withScheme) };
  const { session } = await checkAuditOptions(options);
  if (session) console.error(`session: ${session}`);
  const imageScreenshots = options.skipImages ? false : await screenshotChoice(!!options.auth, values.images, values['no-images']);
  const config = await buildAuditConfig({ ...options, imageScreenshots, out: values.out }, log);
  const result = await runSingleAudit(config, values.out, log);
  console.log(JSON.stringify(auditSummary(result), null, 2));
}

async function batch(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h')) return void process.stdout.write(USAGE);
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...AUDIT_ARGS, base: { type: 'string' }, name: { type: 'string' }, parallel: { type: 'string' }, 'same-pages-from': { type: 'string' } } });
  const source = positionals[0];
  if (!source) throw new Error('missing <batch file>\n\n' + USAGE);
  if (values['same-pages']) throw new Error('--same-pages applies to one audit: set "samePages" on the entry in a .json batch file');
  // '-' reads the list from stdin (JSON if it starts with '{', else the text format): no file to write first.
  const fromStdin = source === '-';
  const text = fromStdin ? await readStdin() : await readFile(source, 'utf8');
  const file = parseBatchFile(text, fromStdin ? (text.trimStart().startsWith('{') ? 'stdin.json' : 'stdin.txt') : source);
  if (values.name?.trim()) file.name = values.name.trim();
  const entries = resolveEntries(file, settingsFromArgs(values), values.base);
  const name = fromStdin && !file.name ? 'batch' : batchName(file, source);
  const parallel = values.parallel === undefined ? 1 : Number(values.parallel);
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error(`--parallel: expected a whole number of 1 or more, got: ${values.parallel}`);
  if (values['same-pages-from']) {
    const { source: from, warnings } = await applySamePagesFrom(entries, values['same-pages-from'], { out: values.out, name });
    console.error(`same pages as ${from}`);
    for (const w of warnings) console.error(`  ${w}`);
  }

  const errors = await preflight(entries);
  if (errors.length) throw new Error(`batch not started, ${errors.length} problem(s):\n- ${errors.join('\n- ')}`);
  for (const e of entries.filter((e) => e.options.auth)) console.error(`session for ${e.label}: ${(await checkAuditOptions(e.options)).session}`);

  // Asked once for the whole batch; logged-out entries keep the single-audit default (screenshots unless --no-images).
  const anyLoggedIn = entries.some((e) => e.options.auth && !e.options.skipImages);
  const imageScreenshots = {
    loggedOut: !values['no-images'],
    loggedIn: anyLoggedIn ? await screenshotChoice(true, values.images, values['no-images']) : false,
  };

  console.error(`Batch: ${entries.length} audit(s)${parallel > 1 ? `, up to ${parallel} at once (one per origin)` : ''}`);
  const { batchDir, batch: b } = await runBatch({ name, source: fromStdin ? 'stdin' : source, entries, imageScreenshots, out: values.out, log, parallel });
  console.log(
    JSON.stringify(
      {
        batchDir,
        index: join(batchDir, 'index.html'),
        summary: b.summary,
        entries: b.entries.map((e) => ({
          label: e.label,
          status: e.status,
          ...(e.status === 'ok' ? { score: e.score!.overall } : {}),
          ...(e.delta !== undefined ? { delta: e.delta } : {}),
          ...(e.error ? { error: e.error } : {}),
          ...(e.reportDir ? { reportDir: join(batchDir, e.reportDir) } : {}),
        })),
      },
      null,
      2,
    ),
  );
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

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("batch -: pipe the list in, e.g. printf '/shop\\n/cart\\n' | npm run -s batch -- - --base https://site.com");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function renderBatchCmd(argv: string[]) {
  if (!argv[0]) throw new Error('usage: daredevil render-batch <batchDir containing batch.json>');
  console.log(await renderBatch(argv[0]));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
