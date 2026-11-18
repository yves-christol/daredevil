import type { Level, Principle } from './types.ts';

const PRINCIPLES: Principle[] = ['perceivable', 'operable', 'understandable', 'robust'];

/** Extract WCAG success criteria from axe tags: "wcag1412" -> "1.4.12". */
export function successCriteria(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(t);
    if (m) out.push(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return out;
}

export function levelOf(tags: string[]): Level {
  let level: Level = 'none';
  for (const t of tags) {
    const m = /^wcag2\d?(a{1,3})$/.exec(t);
    if (!m) continue;
    const l = m[1].toUpperCase() as Level;
    // keep the least strict level if several are present
    if (level === 'none' || l.length < level.length) level = l;
  }
  return level;
}

export function principleOf(tags: string[]): Principle {
  const sc = successCriteria(tags)[0];
  if (!sc) return 'best-practice';
  return PRINCIPLES[Number(sc[0]) - 1] ?? 'best-practice';
}

/** A rule counts toward the headline score if it maps to WCAG level A or AA. */
export function isScored(level: Level): boolean {
  return level === 'A' || level === 'AA';
}
