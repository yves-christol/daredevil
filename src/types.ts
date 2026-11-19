export const SCHEMA_VERSION = '1.0.0';

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';
export type Principle = 'perceivable' | 'operable' | 'understandable' | 'robust' | 'best-practice';
export type Level = 'A' | 'AA' | 'AAA' | 'none';

export interface AuditConfig {
  startUrl: string;
  /** Origin + path prefix that bounds the crawl, e.g. https://www.mysite.com/shop */
  scope: { origin: string; pathPrefix: string };
  /**
   * Only for an audit with several start URLs (one combined report, possibly across hosts):
   * all of them and their scopes, in the given order; `startUrl` / `scope` are the first.
   * The crawl stays inside any of the scopes and shares maxPages evenly between them.
   */
  startUrls?: string[];
  scopes?: { origin: string; pathPrefix: string }[];
  maxPages: number;
  concurrency: number;
  viewport: { width: number; height: number };
  waitMs: number;
  timeoutMs: number;
  /** Defaults to the browser UA with "Headless" removed (many sites block headless UAs) + a daredevil token. */
  userAgent?: string;
  keepQuery: boolean;
  tags: string[];
  keyboardProbe: boolean;
  /** Dismiss cookie-consent dialogs (reject / continue without accepting) before scanning. */
  dismissConsent: boolean;
  /** Extra CSS selector of a consent 'reject' control, tried before the built-in list. */
  consentSelector?: string;
  /** Inventory of images with alt text (selector, src, alt), for the AI alt-text review. */
  imageInventory: boolean;
  /** Element screenshots of those images. Off by default for logged-in audits (personal data). */
  imageScreenshots: boolean;
  /** When set, the crawl is replaced by this fixed page list (for comparable re-runs). */
  fixedPages?: string[];
  /** URL patterns (regex sources, case-insensitive) never enqueued. */
  exclude?: string[];
  /** Authenticated audit: a saved login session is loaded into every page. */
  auth?: AuthConfig;
}

export interface AuthConfig {
  /** Path of the Playwright storage-state file (its content never goes into a report). */
  stateFile: string;
  /** CSS selector visible only when logged in; its absence marks the page `auth-lost`. */
  loggedInCheck?: string;
}

export interface NodeResult {
  selector: string;
  html: string;
  failureSummary?: string;
  /** Root-cause signature used for grouping (see group.ts). */
  signature: string;
  groupId: string;
  /** Rule-specific data, e.g. colour-contrast values. */
  data?: Record<string, unknown>;
}

export interface RuleResult {
  ruleId: string;
  impact: Impact | null;
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  /** WCAG success criteria, e.g. ["1.4.3"] */
  wcag: string[];
  level: Level;
  principle: Principle;
  nodes: NodeResult[];
}

export interface KeyboardProbe {
  tabStops: number;
  /** True when the probe stopped at its Tab-press limit (not a full cycle): unreached elements are then expected. */
  capped?: boolean;
  tabbableElements: number;
  firstStop?: string;
  hasSkipLink: boolean;
  /** Elements that receive focus with no visible style change. */
  noVisibleFocus: { selector: string; html: string }[];
  /** Element where focus stopped moving, if any. */
  possibleTrap?: string;
}

export interface ImageInfo {
  selector: string;
  src: string;
  alt: string;
  /** Path (relative to report dir) of an element screenshot, for alt-text quality review. */
  screenshot?: string;
}

export interface PageResult {
  url: string;
  path: string;
  /** `auth-lost`: an authenticated page landed on a login page (session expired or rejected). */
  status: 'ok' | 'error' | 'skipped' | 'auth-lost';
  /** The URL that was requested, when it redirected (server or client-side) to `url`. */
  redirectedFrom?: string;
  error?: string;
  title?: string;
  httpStatus?: number;
  violations: RuleResult[];
  incomplete: RuleResult[];
  passes: { ruleId: string; nodeCount: number }[];
  keyboard?: KeyboardProbe;
  images?: ImageInfo[];
  /** Assisted probes that failed on this page (their data is then missing). */
  probeErrors?: string[];
  /** Cookie-consent handling on this page. */
  consent?: { dismissed: boolean; method?: string };
  score?: PageScore;
}

export interface ScoreBreakdown {
  /** Headline: WCAG A + AA rules only, 0-100, higher is better. */
  overall: number;
  byPrinciple: Record<Exclude<Principle, 'best-practice'>, number>;
  byLevel: { A: number; AA: number };
  /** Non-WCAG axe best-practice rules; reported, not part of the headline. */
  bestPractice: number;
  /** Site only (scoring v2+): plain mean of page scores, for reference. */
  mean?: number;
  /** Site only (scoring v2+): number of lowest-scoring pages the site scores are computed from. */
  worstPages?: number;
}

export interface PageScore extends ScoreBreakdown {
  penalty: number;
}

export interface IssueGroup {
  id: string;
  ruleId: string;
  impact: Impact | null;
  help: string;
  description: string;
  helpUrl: string;
  wcag: string[];
  level: Level;
  principle: Principle;
  scored: boolean;
  /** Human-readable root-cause signature (component / colour pair / selector pattern). */
  signature: string;
  occurrences: number;
  pageCount: number;
  pages: string[];
  /** Distinct normalised selector patterns in this group (where to look). */
  patterns: string[];
  examples: { page: string; selector: string; html: string; failureSummary?: string; data?: Record<string, unknown> }[];
  /** Site score increase if every node of this group were fixed. Use to prioritise. */
  estimatedScoreGain: number;
}

export interface Report {
  schemaVersion: string;
  tool: { name: 'daredevil'; version: string; axeVersion: string; scoringVersion: string; browser: string };
  generatedAt: string;
  config: AuditConfig;
  summary: {
    score: ScoreBreakdown;
    pagesScanned: number;
    pagesFailed: number;
    /** Pages that landed on a login page during an authenticated audit. */
    pagesAuthLost?: number;
    /** Why the crawl stopped early, if it did. */
    stopped?: string;
    violations: { groups: number; nodes: number; byImpact: Record<Impact, number> };
    needsReview: { groups: number; nodes: number };
  };
  /** Violations grouped by root cause, sorted by estimatedScoreGain (desc). */
  issues: IssueGroup[];
  /** axe "incomplete" results: could not be decided automatically, need human/AI review. Not scored. */
  needsReview: IssueGroup[];
  pages: PageResult[];
}

/** Agent finding as written in assisted.json. */
export interface AssistedFinding {
  id: string;
  category: string;
  wcag?: string[];
  impact?: Impact;
  confidence?: 'high' | 'medium' | 'low';
  page?: string;
  selector?: string;
  evidence: string;
  recommendation: string;
}
