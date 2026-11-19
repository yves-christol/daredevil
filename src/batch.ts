import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { Impact, IssueGroup, Report, ScoreBreakdown } from './types.ts';
import { diffReports } from './report.ts';
import { scopeFromUrl } from './crawl.ts';
import { SCORING_VERSION } from './score.ts';
import { batchMarkdown, renderBatchHtml } from './batchhtml.ts';
import {
  DEFAULT_AUDIT_SETTINGS,
  VERSION,
  buildAuditConfig,
  checkAuditOptions,
  parseViewport,
  runSingleAudit,
  timestamp,
  withScheme,
  type AuditOptions,
  type AuditSettings,
} from './run.ts';

/**
 * Batch audits: one audit per entry of a batch file, each written to its usual
 * reports/<slug>/<stamp>/ (so per-scope history, auto-diff and --same-pages keep working),
 * plus reports/_batches/<name>/<stamp>/batch.json listing every entry's result.
 *
 * Batch file formats:
 *   .txt   one entry per line: `<url or /path> [+ <url or /path> ...] [label]`; `#` comments;
 *          `base: <url>` and `name: <name>` directives. CLI options apply to every entry.
 *   .json  { "name"?, "base"?, "defaults"?: {settings}, "entries": [ "<url or /path>" |
 *          { "url": "<url or /path>" | ["<url or /path>", ...], "label"?, ...settings } ] }
 *          (settings: AuditSettings keys, viewport as "WxH")
 *
 * An entry with several URLs is one audit of all their scopes together: one report, one score.
 *
 * Precedence: built-in defaults < file "defaults" < CLI options < entry settings.
 * `exclude` patterns add up across all levels. Paths (starting with "/") are resolved against
 * the base URL's origin.
 */

export const BATCH_SCHEMA_VERSION = '1.0.0';

export type EntrySettings = Partial<AuditSettings>;

export interface BatchFileEntry {
  /** One or more URLs or /paths (several: one combined audit). */
  urls: string[];
  label?: string;
  settings: EntrySettings;
}

export interface BatchFile {
  name?: string;
  base?: string;
  defaults: EntrySettings;
  entries: BatchFileEntry[];
}

/** An entry ready to run: URLs resolved, options merged. */
export interface BatchEntry {
  /** The first URL (the only one, usually). */
  url: string;
  /** All URLs, resolved. */
  urls: string[];
  label: string;
  options: Omit<AuditOptions, 'imageScreenshots' | 'out'>;
}

type Kind = 'number' | 'boolean' | 'string' | 'strings' | 'viewport';
const SETTING_KINDS: Record<keyof AuditSettings, Kind> = {
  maxPages: 'number',
  concurrency: 'number',
  viewport: 'viewport',
  waitMs: 'number',
  timeoutMs: 'number',
  userAgent: 'string',
  keepQuery: 'boolean',
  samePages: 'string',
  skipBestPractice: 'boolean',
  skipKeyboard: 'boolean',
  keepConsent: 'boolean',
  consentSelector: 'string',
  skipImages: 'boolean',
  exclude: 'strings',
  auth: 'string',
  loggedInCheck: 'string',
};

/** Validate and convert a JSON settings object (unknown keys are errors: they are usually typos). */
function parseSettings(obj: Record<string, unknown>, where: string, skip: string[] = []): EntrySettings {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (skip.includes(k)) continue;
    const kind = SETTING_KINDS[k as keyof AuditSettings];
    if (!kind) {
      const hint = k === 'images' ? ' (image screenshots are decided on the command line: --images / --no-images)' : '';
      throw new Error(`${where}: unknown setting "${k}"${hint}. Known: ${Object.keys(SETTING_KINDS).join(', ')}`);
    }
    const bad = (expected: string) => new Error(`${where}: "${k}" must be ${expected}`);
    if (kind === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad('a non-negative number');
      out[k] = v;
    } else if (kind === 'boolean') {
      if (typeof v !== 'boolean') throw bad('true or false');
      out[k] = v;
    } else if (kind === 'string') {
      if (typeof v !== 'string' || !v) throw bad('a non-empty string');
      out[k] = v;
    } else if (kind === 'strings') {
      const list = typeof v === 'string' ? [v] : v;
      if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) throw bad('a string or an array of strings');
      out[k] = list;
    } else {
      if (typeof v !== 'string') throw bad('a "<width>x<height>" string');
      try {
        out[k] = parseViewport(v);
      } catch (e) {
        throw new Error(`${where}: ${(e as Error).message}`);
      }
    }
  }
  return out as EntrySettings;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseBatchFile(text: string, fileName: string): BatchFile {
  if (extname(fileName).toLowerCase() === '.json') return parseJsonBatch(text, fileName);
  const file: BatchFile = { defaults: {}, entries: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const directive = /^(base|name)\s*:\s*(.+)$/i.exec(line);
    if (directive && !/^https?:\/\//i.test(line)) {
      file[directive[1].toLowerCase() as 'base' | 'name'] = directive[2].trim();
      continue;
    }
    // "<url> + <url> + ... label": URLs joined by a standalone "+" form one combined audit.
    const words = line.split(/\s+/);
    const urls = [words.shift()!];
    while (words[0] === '+') {
      words.shift();
      if (!words.length) throw new Error(`${fileName}: "+" at the end of the line: ${line}`);
      urls.push(words.shift()!);
    }
    file.entries.push({ urls, label: words.join(' ') || undefined, settings: {} });
  }
  return file;
}

function parseJsonBatch(text: string, fileName: string): BatchFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${fileName}: invalid JSON: ${(e as Error).message}`);
  }
  if (!isObject(data)) throw new Error(`${fileName}: expected an object with an "entries" array`);
  for (const k of Object.keys(data)) if (!['name', 'base', 'defaults', 'entries'].includes(k)) throw new Error(`${fileName}: unknown key "${k}"`);
  if (data.name !== undefined && typeof data.name !== 'string') throw new Error(`${fileName}: "name" must be a string`);
  if (data.base !== undefined && typeof data.base !== 'string') throw new Error(`${fileName}: "base" must be a string`);
  if (data.defaults !== undefined && !isObject(data.defaults)) throw new Error(`${fileName}: "defaults" must be an object`);
  if (!Array.isArray(data.entries)) throw new Error(`${fileName}: "entries" must be an array`);
  const entries = data.entries.map((e, i): BatchFileEntry => {
    const where = `${fileName}: entries[${i}]`;
    if (typeof e === 'string') return { urls: [e], settings: {} };
    if (!isObject(e)) throw new Error(`${where}: expected a URL string or an object with "url"`);
    const urls = typeof e.url === 'string' ? [e.url] : e.url;
    if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => typeof u === 'string' && u)) {
      throw new Error(`${where}: "url" must be a URL string or a non-empty array of URL strings`);
    }
    if (e.label !== undefined && typeof e.label !== 'string') throw new Error(`${where}: "label" must be a string`);
    return { urls: urls as string[], label: e.label as string | undefined, settings: parseSettings(e, where, ['url', 'label']) };
  });
  return {
    name: data.name as string | undefined,
    base: data.base as string | undefined,
    defaults: data.defaults ? parseSettings(data.defaults as Record<string, unknown>, `${fileName}: defaults`) : {},
    entries,
  };
}

/** Same rule as the report folder name (several URLs: the set, in any order), so two entries never write into the same history. */
export function scopeKey(urls: string | string[], auth: boolean): string {
  const keys = (typeof urls === 'string' ? [urls] : urls).map((u) => {
    const s = scopeFromUrl(u);
    return s.origin + (s.pathPrefix || '/');
  });
  return keys.sort().join(' + ') + (auth ? ' (logged in)' : '');
}

export function resolveEntries(file: BatchFile, cli: EntrySettings, cliBase?: string): BatchEntry[] {
  if (file.entries.length === 0) throw new Error('the batch file has no entries');
  const base = cliBase ?? file.base;
  let baseUrl: URL | undefined;
  if (base) {
    try {
      baseUrl = new URL(withScheme(base));
    } catch {
      throw new Error(`base: not a valid URL: ${base}`);
    }
  }
  const seen = new Map<string, string>();
  return file.entries.map((e, i) => {
    const urls = e.urls.map((raw) => {
      let url: string;
      if (raw.startsWith('/')) {
        if (!baseUrl) throw new Error(`entry ${i + 1} (${raw}) is a path: give a base URL (--base, or "base" in the file)`);
        url = new URL(raw, baseUrl.origin).toString();
      } else {
        url = withScheme(raw);
      }
      try {
        new URL(url);
      } catch {
        throw new Error(`entry ${i + 1}: not a valid URL: ${raw}`);
      }
      return url;
    });
    const options = {
      ...DEFAULT_AUDIT_SETTINGS,
      ...file.defaults,
      ...cli,
      ...e.settings,
      exclude: [...(file.defaults.exclude ?? []), ...(cli.exclude ?? []), ...(e.settings.exclude ?? [])],
      startUrls: urls,
    };
    const key = scopeKey(urls, !!options.auth);
    const dup = seen.get(key);
    if (dup) throw new Error(`entries ${dup} and ${i + 1} audit the same scope (${key}): keep one`);
    seen.set(key, String(i + 1));
    const label = e.label ?? urls.map((u) => u.replace(/^https?:\/\//, '').replace(/\/$/, '')).join(' + ');
    return { url: urls[0], urls, label, options };
  });
}

/** Every problem found without a browser, for all entries at once (an expired session is better found now than mid-batch). */
export async function preflight(entries: BatchEntry[]): Promise<string[]> {
  const errors: string[] = [];
  for (const [i, e] of entries.entries()) {
    const where = `entry ${i + 1} (${e.label})`;
    // Exclude patterns and the session are checked separately, so one does not hide the other.
    for (const part of [{ ...e.options, auth: undefined }, { ...e.options, exclude: [] }]) {
      try {
        await checkAuditOptions(part);
      } catch (err) {
        errors.push(`${where}: ${(err as Error).message}`);
      }
    }
    if (e.options.samePages && !existsSync(e.options.samePages)) errors.push(`${where}: samePages: no such file: ${e.options.samePages}`);
  }
  return errors;
}

// ---------------------------------------------------------------- batch.json

/**
 * ok: scored. no-pages: no page could be scanned (no score). auth-lost: most pages landed on a
 * login page (score not meaningful). error: the audit crashed. pending: not run (interrupted).
 */
export type EntryStatus = 'ok' | 'no-pages' | 'auth-lost' | 'error' | 'pending';

export interface BatchEntryResult {
  /** The first start URL. */
  url: string;
  /** All start URLs, only when there are several (one combined audit). */
  urls?: string[];
  label: string;
  loggedIn: boolean;
  status: EntryStatus;
  error?: string;
  /** Report folder, relative to the batch folder. */
  reportDir?: string;
  durationMs?: number;
  score?: Pick<ScoreBreakdown, 'overall' | 'byLevel' | 'byPrinciple' | 'bestPractice'>;
  /** Overall score change vs. the previous run of the same scope. */
  delta?: number;
  comparableWithPrevious?: boolean;
  pagesScanned?: number;
  pagesFailed?: number;
  pagesAuthLost?: number;
  stopped?: string;
  issueGroups?: number;
  violationNodes?: number;
  byImpact?: Record<Impact, number>;
  /** The issue group whose fix gains the most points. */
  topIssue?: { id: string; ruleId: string; help: string; impact: Impact | null; signature: string; pageCount: number; estimatedScoreGain: number };
  /** This scope was not in the previous batch. */
  newSincePrevious?: true;
  /** Versus the same scope in the previous batch (when there is one and the entry was scored in both). */
  sincePrevious?: {
    before: number;
    delta: number;
    /** Same pages, same tool versions and options (see diffReports). */
    comparable: boolean;
    /** Issue groups gone / appeared; absent when the previous report could not be read. */
    fixed?: number;
    introduced?: number;
  };
}

/** A root cause (same rule, same signature, so the same group id) found in several audits. */
export interface SharedIssue {
  id: string;
  ruleId: string;
  help: string;
  impact: Impact | null;
  signature: string;
  scored: boolean;
  occurrences: number;
  entries: { index: number; label: string; occurrences: number; pageCount: number; estimatedScoreGain: number }[];
}

export interface BatchReport {
  schemaVersion: string;
  tool: { name: 'daredevil'; version: string; scoringVersion: string };
  name: string;
  source: string;
  generatedAt: string;
  /** false while running, or if the batch was interrupted. */
  complete: boolean;
  imageScreenshots: { loggedOut: boolean; loggedIn: boolean };
  /** Descriptive statistics over `ok` entries. Not a score: each entry keeps its own. */
  summary: { entries: number; ok: number; notOk: number; min?: number; median?: number; max?: number };
  entries: BatchEntryResult[];
  /** Root causes found in at least 2 scored entries, the most widespread first. */
  shared?: SharedIssue[];
  /** The latest complete batch with the same name, if any. */
  previous?: {
    /** Its folder, relative to this batch's folder. */
    dir: string;
    generatedAt: string;
    summary: BatchReport['summary'];
    /** Labels of entries only in this batch / only in the previous one. */
    added: string[];
    removed: string[];
  };
}

export const SHARED_LIMIT = 25;

/** Root causes present in 2+ scored entries, by number of entries, then total estimated gain. */
export function sharedIssues(entries: BatchEntryResult[], issues: (IssueGroup[] | undefined)[], limit = SHARED_LIMIT): SharedIssue[] {
  const byId = new Map<string, SharedIssue>();
  entries.forEach((e, index) => {
    if (e.status !== 'ok') return;
    for (const g of issues[index] ?? []) {
      let s = byId.get(g.id);
      if (!s) byId.set(g.id, (s = { id: g.id, ruleId: g.ruleId, help: g.help, impact: g.impact, signature: g.signature, scored: g.scored, occurrences: 0, entries: [] }));
      s.occurrences += g.occurrences;
      s.entries.push({ index, label: e.label, occurrences: g.occurrences, pageCount: g.pageCount, estimatedScoreGain: g.estimatedScoreGain });
    }
  });
  const gain = (s: SharedIssue) => s.entries.reduce((a, x) => a + x.estimatedScoreGain, 0);
  return [...byId.values()]
    .filter((s) => s.entries.length >= 2)
    .sort((a, b) => b.entries.length - a.entries.length || gain(b) - gain(a) || b.occurrences - a.occurrences)
    .slice(0, limit);
}

/** The latest complete batch.json in `batchesDir` (reports/_batches/<slug>/) before `stamp`. */
export async function findPreviousBatch(batchesDir: string, stamp: string): Promise<{ dir: string; batch: BatchReport } | undefined> {
  if (!existsSync(batchesDir)) return undefined;
  const stamps = (await readdir(batchesDir)).filter((d) => d < stamp).sort().reverse();
  for (const d of stamps) {
    const file = join(batchesDir, d, 'batch.json');
    if (!existsSync(file)) continue;
    try {
      const b: BatchReport = JSON.parse(await readFile(file, 'utf8'));
      if (b.complete) return { dir: join(batchesDir, d), batch: b };
    } catch {
      /* unreadable: skip */
    }
  }
  return undefined;
}

const entryKey = (e: { url: string; urls?: string[]; loggedIn: boolean }) => scopeKey(e.urls ?? e.url, e.loggedIn);

/** Compare a scored entry with the same scope in the previous batch, using its report.json when still there. */
export async function compareWithPrevious(cur: BatchEntryResult, report: Report, prev: { dir: string; batch: BatchReport }): Promise<BatchEntryResult['sincePrevious']> {
  const p = prev.batch.entries.find((x) => entryKey(x) === entryKey(cur));
  if (!p || p.status !== 'ok' || !p.score || cur.status !== 'ok' || !cur.score) return undefined;
  const file = p.reportDir ? join(prev.dir, p.reportDir, 'report.json') : undefined;
  if (file && existsSync(file)) {
    try {
      const d = diffReports(JSON.parse(await readFile(file, 'utf8')), report);
      return { before: d.overall.before, delta: d.overall.delta, comparable: d.comparable, fixed: d.fixed.length, introduced: d.introduced.length };
    } catch {
      /* fall through: score only */
    }
  }
  return { before: p.score.overall, delta: Math.round((cur.score.overall - p.score.overall) * 10) / 10, comparable: false };
}

export function previousInfo(prev: { dir: string; batch: BatchReport }, batchDir: string, entries: { url: string; urls?: string[]; label: string; loggedIn: boolean }[]): NonNullable<BatchReport['previous']> {
  const now = new Set(entries.map(entryKey));
  const before = new Set(prev.batch.entries.map(entryKey));
  return {
    dir: relative(batchDir, prev.dir),
    generatedAt: prev.batch.generatedAt,
    summary: prev.batch.summary,
    added: entries.filter((e) => !before.has(entryKey(e))).map((e) => e.label),
    removed: prev.batch.entries.filter((e) => !now.has(entryKey(e))).map((e) => e.label),
  };
}

export function entryResult(e: BatchEntry, r: { reportDir: string; report: Report; diff?: { overall: { delta: number }; comparable: boolean } }, batchDir: string): BatchEntryResult {
  const s = r.report.summary;
  const lost = s.pagesAuthLost ?? 0;
  const top = r.report.issues.find((g) => g.scored);
  const status: EntryStatus = s.pagesScanned === 0 ? 'no-pages' : lost > s.pagesScanned ? 'auth-lost' : 'ok';
  return {
    url: e.url,
    ...(e.urls.length > 1 ? { urls: e.urls } : {}),
    label: e.label,
    loggedIn: !!e.options.auth,
    status,
    reportDir: relative(batchDir, r.reportDir),
    // No page, no score (the engine's 0-page score is not a measurement). auth-lost keeps it, flagged by its status.
    ...(status === 'no-pages'
      ? {}
      : { score: { overall: s.score.overall, byLevel: s.score.byLevel, byPrinciple: s.score.byPrinciple, bestPractice: s.score.bestPractice } }),
    delta: r.diff?.overall.delta,
    comparableWithPrevious: r.diff?.comparable,
    pagesScanned: s.pagesScanned,
    pagesFailed: s.pagesFailed,
    ...(e.options.auth ? { pagesAuthLost: lost } : {}),
    ...(s.stopped ? { stopped: s.stopped } : {}),
    issueGroups: s.violations.groups,
    violationNodes: s.violations.nodes,
    byImpact: s.violations.byImpact,
    ...(top
      ? { topIssue: { id: top.id, ruleId: top.ruleId, help: top.help, impact: top.impact, signature: top.signature, pageCount: top.pageCount, estimatedScoreGain: top.estimatedScoreGain } }
      : {}),
  };
}

export function batchSummary(entries: BatchEntryResult[]): BatchReport['summary'] {
  const scores = entries.filter((e) => e.status === 'ok').map((e) => e.score!.overall).sort((a, b) => a - b);
  const n = scores.length;
  const median = n === 0 ? undefined : n % 2 ? scores[(n - 1) / 2] : Math.round(((scores[n / 2 - 1] + scores[n / 2]) / 2) * 10) / 10;
  return {
    entries: entries.length,
    ok: n,
    notOk: entries.filter((e) => e.status !== 'ok' && e.status !== 'pending').length,
    ...(n ? { min: scores[0], median, max: scores[n - 1] } : {}),
  };
}

/** Display name: the file's "name", else the file name. */
export const batchName = (file: BatchFile, sourcePath: string) => file.name?.trim() || basename(sourcePath, extname(sourcePath));

/** Folder name under reports/_batches/. */
export const batchSlug = (name: string) => name.replace(/[^a-zA-Z0-9.-]+/g, '_').replace(/^[._]+/, '') || 'batch';

export interface RunBatchOptions {
  name: string;
  source: string;
  entries: BatchEntry[];
  imageScreenshots: { loggedOut: boolean; loggedIn: boolean };
  out: string;
  log: (m: string) => void;
  /** Audits run at once (default 1). Never two on the same origin at the same time. */
  parallel?: number;
}

/**
 * Run `fn` over items, at most `parallel` at once, never two items sharing a key at once
 * (keys = origins: parallel requests to one host are what trips bot protection; an audit of
 * several hosts holds all of them). Items start in order, skipping over those with a busy key.
 * `fn` must not throw.
 */
export async function runPool<T>(items: T[], parallel: number, keyOf: (t: T) => string | string[], fn: (t: T, index: number) => Promise<void>): Promise<void> {
  const pending = items.map((_, i) => i);
  const active = new Set<Promise<void>>();
  const busy = new Set<string>();
  const limit = Math.max(1, Math.floor(parallel) || 1);
  while (pending.length || active.size) {
    while (active.size < limit) {
      const keys = (t: T) => [keyOf(t)].flat();
      const k = pending.findIndex((i) => !keys(items[i]).some((x) => busy.has(x)));
      if (k < 0) break;
      const i = pending.splice(k, 1)[0];
      const held = keys(items[i]);
      for (const x of held) busy.add(x);
      const p: Promise<void> = fn(items[i], i).finally(() => {
        active.delete(p);
        for (const x of held) busy.delete(x);
      });
      active.add(p);
    }
    if (active.size) await Promise.race(active);
  }
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/**
 * --same-pages-from: give each entry the report.json its scope produced in another batch
 * (a batch.json, its folder, or "latest" for the last complete batch of this name), so exactly
 * the same pages are re-scanned. An entry's own samePages wins. Returns warnings for entries
 * that will be crawled normally.
 */
export async function applySamePagesFrom(entries: BatchEntry[], from: string, ctx: { out: string; name: string }): Promise<{ source: string; warnings: string[] }> {
  let dir: string;
  let batch: BatchReport;
  if (from === 'latest') {
    const found = await findPreviousBatch(join(ctx.out, '_batches', batchSlug(ctx.name)), '\uffff');
    if (!found) throw new Error(`--same-pages-from latest: no complete batch named "${ctx.name}" in ${join(ctx.out, '_batches')}`);
    ({ dir, batch } = found);
  } else {
    const file = from.endsWith('.json') ? from : join(from, 'batch.json');
    if (!existsSync(file)) throw new Error(`--same-pages-from: no such batch file: ${file}`);
    dir = dirname(file);
    try {
      batch = JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
      throw new Error(`--same-pages-from: ${file}: ${(e as Error).message}`);
    }
    if (!Array.isArray(batch.entries)) throw new Error(`--same-pages-from: ${file} is not a batch.json`);
  }
  const byKey = new Map(batch.entries.map((e) => [entryKey(e), e]));
  const warnings: string[] = [];
  for (const e of entries) {
    if (e.options.samePages) continue;
    const p = byKey.get(scopeKey(e.urls, !!e.options.auth));
    if (!p) warnings.push(`${e.label}: not in that batch, crawled normally`);
    else if (p.status !== 'ok' || !p.reportDir) warnings.push(`${e.label}: not scored in that batch (${p.status}), crawled normally`);
    else e.options.samePages = join(dir, p.reportDir, 'report.json');
  }
  return { source: join(dir, 'batch.json'), warnings };
}

/** Run entries one after another. A failing entry is recorded and the batch goes on. batch.json is rewritten after each entry. */
export async function runBatch(o: RunBatchOptions): Promise<{ batchDir: string; batch: BatchReport }> {
  const batchesDir = join(o.out, '_batches', batchSlug(o.name));
  const stamp = timestamp();
  const batchDir = join(batchesDir, stamp);
  await mkdir(batchDir, { recursive: true });
  const prev = await findPreviousBatch(batchesDir, stamp);
  /** Issue groups of each entry, kept in memory for the shared root causes. */
  const issues: (IssueGroup[] | undefined)[] = [];
  const batch: BatchReport = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    tool: { name: 'daredevil', version: VERSION, scoringVersion: SCORING_VERSION },
    name: o.name,
    source: o.source,
    generatedAt: new Date().toISOString(),
    complete: false,
    imageScreenshots: o.imageScreenshots,
    summary: batchSummary([]),
    entries: o.entries.map((e) => ({ url: e.url, ...(e.urls.length > 1 ? { urls: e.urls } : {}), label: e.label, loggedIn: !!e.options.auth, status: 'pending' })),
  };
  const prevKeys = new Set(prev?.batch.entries.map(entryKey));
  if (prev) {
    batch.previous = previousInfo(prev, batchDir, batch.entries);
    for (const e of batch.entries) if (!prevKeys.has(entryKey(e))) e.newSincePrevious = true;
  }
  // Rewritten after each entry: the page shows progress, and an interrupted batch keeps what was done.
  // Saves are chained so parallel entries never write the files at the same time.
  let saving = Promise.resolve();
  const save = () =>
    (saving = saving.then(async () => {
      batch.summary = batchSummary(batch.entries);
      const shared = sharedIssues(batch.entries, issues);
      if (shared.length) batch.shared = shared;
      await writeBatchFiles(batchDir, batch);
    }));
  await save();

  const n = o.entries.length;
  const parallel = o.parallel ?? 1;
  await runPool(o.entries, parallel, (e) => e.urls.map(originOf), async (e, i) => {
    const tag = `[${i + 1}/${n}]`;
    // With several audits at once, prefix every line so the log stays readable.
    const log = parallel > 1 ? (m: string) => o.log(m.split('\n').map((l) => (l ? `${tag} ${l}` : l)).join('\n')) : o.log;
    o.log(`\n${tag} ${e.label}`);
    const started = Date.now();
    try {
      const imageScreenshots = e.options.auth ? o.imageScreenshots.loggedIn : o.imageScreenshots.loggedOut;
      const config = await buildAuditConfig({ ...e.options, imageScreenshots, out: o.out }, log);
      const result = await runSingleAudit(config, o.out, log);
      const r: BatchEntryResult = { ...entryResult(e, result, batchDir), durationMs: Date.now() - started };
      if (prev && !prevKeys.has(entryKey(r))) r.newSincePrevious = true;
      if (prev) {
        const since = await compareWithPrevious(r, result.report, prev);
        if (since) r.sincePrevious = since;
      }
      batch.entries[i] = r;
      issues[i] = result.report.issues;
      o.log(`${tag} ${r.status === 'ok' ? `score ${r.score!.overall}` : r.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      batch.entries[i] = { ...batch.entries[i], status: 'error', error: message, durationMs: Date.now() - started };
      o.log(`${tag} error: ${message}`);
    }
    await save();
  });
  batch.complete = true;
  await save();
  return { batchDir, batch };
}

/** batch.json, index.html and index.md (with the agent's summary.md, if present in the folder). */
export async function writeBatchFiles(batchDir: string, batch: BatchReport): Promise<void> {
  const summaryPath = join(batchDir, 'summary.md');
  const summaryMd = existsSync(summaryPath) ? await readFile(summaryPath, 'utf8') : undefined;
  await writeFile(join(batchDir, 'batch.json'), JSON.stringify(batch, null, 2));
  // Entries the agent reviewed: their report folder has its summary.md.
  const reviewed = new Set(batch.entries.flatMap((e, i) => (e.reportDir && existsSync(join(batchDir, e.reportDir, 'summary.md')) ? [i] : [])));
  await writeFile(join(batchDir, 'index.html'), renderBatchHtml(batch, { summaryMd, reviewed }));
  await writeFile(join(batchDir, 'index.md'), batchMarkdown(batch, reviewed));
}

/** Rebuild index.html / index.md from batch.json. */
export async function renderBatch(batchDir: string): Promise<string> {
  const file = join(batchDir, 'batch.json');
  if (!existsSync(file)) throw new Error(`no batch.json in ${batchDir}`);
  const batch: BatchReport = JSON.parse(await readFile(file, 'utf8'));
  await writeBatchFiles(batchDir, batch);
  return join(batchDir, 'index.html');
}
