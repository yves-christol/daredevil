import type { Impact, PageResult, PageScore, Principle, ScoreBreakdown } from './types.ts';
import { isScored } from './wcag.ts';

/**
 * Scoring model (bump SCORING_VERSION whenever any constant or formula changes:
 * scores from different versions are not comparable).
 *
 *   rulePenalty = weight(impact) * (1 + log2(failingNodes))
 *   pageScore   = 100 * exp(-sum(rulePenalty) / K)
 *   siteScore   = mean of the N lowest pageScores, N = max(ceil(10% of pages), 5)
 *                 (all pages when fewer than 5 were scanned)
 *
 * - Impact weights make one critical issue cost far more than one minor issue.
 * - log2 on node count: 200 broken buttons cost more than 1, but not 200x, and fixing
 *   half of them still moves the score (fine-grained progress tracking).
 * - exp(-P/K) maps any penalty onto 0-100 continuously, never saturating at 0.
 * - Worst-pages mean (v2): a plain mean over all pages rose with crawl depth, because deep
 *   crawls add many simple pages that dilute defects on the hub pages. The worst tail
 *   describes the experience where it is worst, does not depend on how many easy pages
 *   were found, and the 5-page floor keeps small crawls from resting on a single page.
 *   The same tail rule applies to every sub-score; the plain mean is kept as `mean`.
 */
export const SCORING_VERSION = '2.0.0';
export const WORST_SHARE = 0.1;
export const WORST_MIN_PAGES = 5;
export const IMPACT_WEIGHT: Record<Impact, number> = { critical: 10, serious: 5, moderate: 2, minor: 1 };
export const K = 100;

const PRINCIPLES = ['perceivable', 'operable', 'understandable', 'robust'] as const;

function toScore(penalty: number): number {
  return round(100 * Math.exp(-penalty / K));
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

interface Penalties {
  wcag: number;
  principle: Record<Principle, number>;
  level: { A: number; AA: number };
}

/** Compute penalties for a page, optionally ignoring nodes of some groups (what-if analysis). */
function pagePenalties(page: PageResult, excludeGroup?: string): Penalties {
  const p: Penalties = {
    wcag: 0,
    principle: { perceivable: 0, operable: 0, understandable: 0, robust: 0, 'best-practice': 0 },
    level: { A: 0, AA: 0 },
  };
  for (const rule of page.violations) {
    const n = excludeGroup ? rule.nodes.filter((x) => x.groupId !== excludeGroup).length : rule.nodes.length;
    if (n === 0) continue;
    const pen = IMPACT_WEIGHT[rule.impact ?? 'moderate'] * (1 + Math.log2(n));
    p.principle[rule.principle] += pen;
    if (isScored(rule.level)) {
      p.wcag += pen;
      p.level[rule.level as 'A' | 'AA'] += pen;
    }
  }
  return p;
}

export function scorePage(page: PageResult, excludeGroup?: string): PageScore {
  const p = pagePenalties(page, excludeGroup);
  return {
    penalty: round(p.wcag, 2),
    overall: toScore(p.wcag),
    byPrinciple: {
      perceivable: toScore(p.principle.perceivable),
      operable: toScore(p.principle.operable),
      understandable: toScore(p.principle.understandable),
      robust: toScore(p.principle.robust),
    },
    byLevel: { A: toScore(p.level.A), AA: toScore(p.level.AA) },
    bestPractice: toScore(p.principle['best-practice']),
  };
}

/** Number of pages the site score is computed from. */
export function worstPageCount(pages: number): number {
  return Math.min(pages, Math.max(Math.ceil(pages * WORST_SHARE), WORST_MIN_PAGES));
}

/** Mean of the lowest worstPageCount(values.length) values (unrounded). */
function worstMean(values: number[]): number {
  if (values.length === 0) return 0;
  const tail = [...values].sort((a, b) => a - b).slice(0, worstPageCount(values.length));
  return tail.reduce((a, v) => a + v, 0) / tail.length;
}

export function scoreSite(pages: PageResult[], excludeGroup?: string): ScoreBreakdown {
  const ok = pages.filter((p) => p.status === 'ok');
  const scores = ok.map((p) => scorePage(p, excludeGroup));
  const worst = (f: (s: PageScore) => number) => round(worstMean(scores.map(f)));
  const byPrinciple = Object.fromEntries(PRINCIPLES.map((k) => [k, worst((s) => s.byPrinciple[k])])) as ScoreBreakdown['byPrinciple'];
  return {
    overall: worst((s) => s.overall),
    byPrinciple,
    byLevel: { A: worst((s) => s.byLevel.A), AA: worst((s) => s.byLevel.AA) },
    bestPractice: worst((s) => s.bestPractice),
    mean: scores.length === 0 ? 0 : round(scores.reduce((a, s) => a + s.overall, 0) / scores.length),
    worstPages: worstPageCount(scores.length),
  };
}

/** Unrounded site score, used for gain estimates. */
export function rawSiteOverall(pages: PageResult[], excludeGroup?: string): number {
  const ok = pages.filter((p) => p.status === 'ok');
  return worstMean(ok.map((p) => 100 * Math.exp(-pagePenalties(p, excludeGroup).wcag / K)));
}
