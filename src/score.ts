import type { Impact, PageResult, PageScore, Principle, ScoreBreakdown } from './types.ts';
import { isScored } from './wcag.ts';

/**
 * Scoring model (bump SCORING_VERSION whenever any constant or formula changes:
 * scores from different versions are not comparable).
 *
 *   rulePenalty = weight(impact) * (1 + log2(failingNodes))
 *   pageScore   = 100 * exp(-sum(rulePenalty) / K)
 *   siteScore   = mean(pageScore) over successfully scanned pages
 *
 * - Impact weights make one critical issue cost far more than one minor issue.
 * - log2 on node count: 200 broken buttons cost more than 1, but not 200x, and fixing
 *   half of them still moves the score (fine-grained progress tracking).
 * - exp(-P/K) maps any penalty onto 0-100 continuously, never saturating at 0.
 * - Averaging pages keeps big and small sites comparable and rewards fixing shared
 *   templates (a header fix lifts every page).
 */
export const SCORING_VERSION = '1.0.0';
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

export function scoreSite(pages: PageResult[], excludeGroup?: string): ScoreBreakdown {
  const ok = pages.filter((p) => p.status === 'ok');
  const scores = ok.map((p) => scorePage(p, excludeGroup));
  const mean = (f: (s: PageScore) => number) =>
    scores.length === 0 ? 0 : round(scores.reduce((a, s) => a + f(s), 0) / scores.length);
  const byPrinciple = Object.fromEntries(PRINCIPLES.map((k) => [k, mean((s) => s.byPrinciple[k])])) as ScoreBreakdown['byPrinciple'];
  return {
    overall: mean((s) => s.overall),
    byPrinciple,
    byLevel: { A: mean((s) => s.byLevel.A), AA: mean((s) => s.byLevel.AA) },
    bestPractice: mean((s) => s.bestPractice),
  };
}

/** Unrounded site score, used for gain estimates. */
export function rawSiteOverall(pages: PageResult[], excludeGroup?: string): number {
  const ok = pages.filter((p) => p.status === 'ok');
  if (ok.length === 0) return 0;
  return ok.reduce((a, p) => a + 100 * Math.exp(-pagePenalties(p, excludeGroup).wcag / K), 0) / ok.length;
}
