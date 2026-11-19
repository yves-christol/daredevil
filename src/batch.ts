import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { Impact, Report, ScoreBreakdown } from './types.ts';
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
 *   .txt   one entry per line: `<url or /path> [label]`; `#` comments; `base: <url>` and
 *          `name: <name>` directives. CLI options apply to every entry.
 *   .json  { "name"?, "base"?, "defaults"?: {settings}, "entries": [ "<url or /path>" |
 *          { "url", "label"?, ...settings } ] }  (settings: AuditSettings keys, viewport as "WxH")
 *
 * Precedence: built-in defaults < file "defaults" < CLI options < entry settings.
 * `exclude` patterns add up across all levels. Paths (starting with "/") are resolved against
 * the base URL's origin.
 */

export const BATCH_SCHEMA_VERSION = '1.0.0';

export type EntrySettings = Partial<AuditSettings>;

export interface BatchFileEntry {
  url: string;
  label?: string;
  settings: EntrySettings;
}

export interface BatchFile {
  name?: string;
  base?: string;
  defaults: EntrySettings;
  entries: BatchFileEntry[];
}

/** An entry ready to run: URL resolved, options merged. */
export interface BatchEntry {
  url: string;
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
    const [url, ...label] = line.split(/\s+/);
    file.entries.push({ url, label: label.join(' ') || undefined, settings: {} });
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
    if (typeof e === 'string') return { url: e, settings: {} };
    if (!isObject(e) || typeof e.url !== 'string' || !e.url) throw new Error(`${where}: expected a URL string or an object with "url"`);
    if (e.label !== undefined && typeof e.label !== 'string') throw new Error(`${where}: "label" must be a string`);
    return { url: e.url, label: e.label as string | undefined, settings: parseSettings(e, where, ['url', 'label']) };
  });
  return {
    name: data.name as string | undefined,
    base: data.base as string | undefined,
    defaults: data.defaults ? parseSettings(data.defaults as Record<string, unknown>, `${fileName}: defaults`) : {},
    entries,
  };
}

/** Same rule as the report folder name, so two entries never write into the same history. */
function scopeKey(url: string, auth: boolean): string {
  const s = scopeFromUrl(url);
  return s.origin + (s.pathPrefix || '/') + (auth ? ' (logged in)' : '');
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
    let url: string;
    if (e.url.startsWith('/')) {
      if (!baseUrl) throw new Error(`entry ${i + 1} (${e.url}) is a path: give a base URL (--base, or "base" in the file)`);
      url = new URL(e.url, baseUrl.origin).toString();
    } else {
      url = withScheme(e.url);
    }
    try {
      new URL(url);
    } catch {
      throw new Error(`entry ${i + 1}: not a valid URL: ${e.url}`);
    }
    const options = {
      ...DEFAULT_AUDIT_SETTINGS,
      ...file.defaults,
      ...cli,
      ...e.settings,
      exclude: [...(file.defaults.exclude ?? []), ...(cli.exclude ?? []), ...(e.settings.exclude ?? [])],
      startUrl: url,
    };
    const key = scopeKey(url, !!options.auth);
    const dup = seen.get(key);
    if (dup) throw new Error(`entries ${dup} and ${i + 1} audit the same scope (${key}): keep one`);
    seen.set(key, String(i + 1));
    return { url, label: e.label ?? url.replace(/^https?:\/\//, '').replace(/\/$/, ''), options };
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
  url: string;
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
}

export function entryResult(e: BatchEntry, r: { reportDir: string; report: Report; diff?: { overall: { delta: number }; comparable: boolean } }, batchDir: string): BatchEntryResult {
  const s = r.report.summary;
  const lost = s.pagesAuthLost ?? 0;
  const top = r.report.issues.find((g) => g.scored);
  const status: EntryStatus = s.pagesScanned === 0 ? 'no-pages' : lost > s.pagesScanned ? 'auth-lost' : 'ok';
  return {
    url: e.url,
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
}

/** Run entries one after another. A failing entry is recorded and the batch goes on. batch.json is rewritten after each entry. */
export async function runBatch(o: RunBatchOptions): Promise<{ batchDir: string; batch: BatchReport }> {
  const batchDir = join(o.out, '_batches', batchSlug(o.name), timestamp());
  await mkdir(batchDir, { recursive: true });
  const batch: BatchReport = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    tool: { name: 'daredevil', version: VERSION, scoringVersion: SCORING_VERSION },
    name: o.name,
    source: o.source,
    generatedAt: new Date().toISOString(),
    complete: false,
    imageScreenshots: o.imageScreenshots,
    summary: batchSummary([]),
    entries: o.entries.map((e) => ({ url: e.url, label: e.label, loggedIn: !!e.options.auth, status: 'pending' })),
  };
  // Rewritten after each entry: the page shows progress, and an interrupted batch keeps what was done.
  const save = async () => {
    batch.summary = batchSummary(batch.entries);
    await writeBatchFiles(batchDir, batch);
  };
  await save();

  for (const [i, e] of o.entries.entries()) {
    o.log(`\n[${i + 1}/${o.entries.length}] ${e.label}`);
    const started = Date.now();
    try {
      const imageScreenshots = e.options.auth ? o.imageScreenshots.loggedIn : o.imageScreenshots.loggedOut;
      const config = await buildAuditConfig({ ...e.options, imageScreenshots, out: o.out }, o.log);
      const result = await runSingleAudit(config, o.out, o.log);
      batch.entries[i] = { ...entryResult(e, result, batchDir), durationMs: Date.now() - started };
      const r = batch.entries[i];
      o.log(`[${i + 1}/${o.entries.length}] ${r.status === 'ok' ? `score ${r.score!.overall}` : r.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      batch.entries[i] = { ...batch.entries[i], status: 'error', error: message, durationMs: Date.now() - started };
      o.log(`[${i + 1}/${o.entries.length}] error: ${message}`);
    }
    await save();
  }
  batch.complete = true;
  await save();
  return { batchDir, batch };
}

/** batch.json, index.html and index.md (with the agent's summary.md, if present in the folder). */
export async function writeBatchFiles(batchDir: string, batch: BatchReport): Promise<void> {
  const summaryPath = join(batchDir, 'summary.md');
  const summaryMd = existsSync(summaryPath) ? await readFile(summaryPath, 'utf8') : undefined;
  await writeFile(join(batchDir, 'batch.json'), JSON.stringify(batch, null, 2));
  await writeFile(join(batchDir, 'index.html'), renderBatchHtml(batch, { summaryMd }));
  await writeFile(join(batchDir, 'index.md'), batchMarkdown(batch));
}

/** Rebuild index.html / index.md from batch.json. */
export async function renderBatch(batchDir: string): Promise<string> {
  const file = join(batchDir, 'batch.json');
  if (!existsSync(file)) throw new Error(`no batch.json in ${batchDir}`);
  const batch: BatchReport = JSON.parse(await readFile(file, 'utf8'));
  await writeBatchFiles(batchDir, batch);
  return join(batchDir, 'index.html');
}
