import { readFileSync } from 'node:fs';

/**
 * Plain-language explanations of axe rules (assets/explanations.json), written by the
 * daredevil agent for developers new to accessibility. Shown in the HTML report behind a
 * "?" button on each defect. Generic per rule, so one library serves every report.
 */
export interface Explanation {
  title: string;
  inShort: string;
  atStake: string;
  affects: string[];
  analogy?: string;
  fix: string[];
  bad?: string;
  good?: string;
  wcag?: string;
}

let library: Record<string, Explanation> = {};
try {
  library = JSON.parse(readFileSync(new URL('../assets/explanations.json', import.meta.url), 'utf8'));
} catch {
  /* library missing or invalid: reports render without "?" buttons */
}

export function explanationFor(ruleId: string): Explanation | undefined {
  const e = library[ruleId];
  return e && typeof e.title === 'string' && typeof e.inShort === 'string' ? e : undefined;
}

export function explainedRuleIds(): string[] {
  return Object.keys(library);
}
