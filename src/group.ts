import { createHash } from 'node:crypto';
import type { IssueGroup, NodeResult, PageResult, RuleResult } from './types.ts';
import { isScored } from './wcag.ts';

const MAX_EXAMPLES = 5;
const MAX_PATTERNS = 15;

/** Drop positional pseudo-classes and digit runs so repeated components share a pattern. */
export function normalizeSelector(selector: string): string {
  return selector
    .replace(/:nth-(child|of-type|last-child|last-of-type)\([^)]*\)/g, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function openTag(html: string): { tag: string; classes: string[]; role?: string; type?: string } | null {
  const m = /^\s*<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/.exec(html);
  if (!m) return null;
  const attrs = m[2];
  const cls = /\sclass\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? '';
  return {
    tag: m[1].toLowerCase(),
    classes: [...new Set(cls.split(/\s+/).filter(Boolean).map((c) => c.replace(/\d+/g, '#')))].sort().slice(0, 6),
    role: /\srole\s*=\s*"([^"]*)"/.exec(attrs)?.[1],
    type: /\stype\s*=\s*"([^"]*)"/.exec(attrs)?.[1],
  };
}

/** Rules whose fix is page/template structure, not a specific element. */
const PAGE_LEVEL = /^(region|bypass|page-has-heading-one|document-title|landmark-|html-|meta-)/;

/**
 * Root-cause signature for a failing node. Nodes with the same rule + signature are
 * assumed to share one fix (same template, same component, same colour tokens):
 *  - page-structure rules  -> one group per rule ("page structure")
 *  - colour contrast       -> one group per fg/bg/font combination (a design token)
 *  - element with classes  -> one group per component (tag + classes)
 *  - unclassed element     -> one group per tag/role (e.g. all unclassed <img>)
 * The precise selector patterns are kept separately (see IssueGroup.patterns).
 */
export function nodeSignature(ruleId: string, selector: string, html: string, data?: Record<string, unknown>): string {
  if (PAGE_LEVEL.test(ruleId)) return 'page structure';
  if (ruleId.startsWith('color-contrast') && data && data.fgColor) {
    return `fg ${data.fgColor} on bg ${data.bgColor}, ${data.fontSize} ${data.fontWeight}`;
  }
  const t = openTag(html);
  if (!t) return normalizeSelector(selector);
  const extra = [t.role && `[role=${t.role}]`, t.type && `[type=${t.type}]`].filter(Boolean).join('');
  return t.classes.length > 0 ? `<${t.tag}${extra}.${t.classes.join('.')}>` : `<${t.tag}${extra}>`;
}

export function groupId(ruleId: string, signature: string): string {
  return createHash('sha1').update(`${ruleId}|${signature}`).digest('hex').slice(0, 10);
}

/** Build site-wide issue groups from per-page rule results. */
export function buildGroups(pages: PageResult[], pick: (p: PageResult) => RuleResult[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const page of pages) {
    for (const rule of pick(page)) {
      for (const node of rule.nodes) addNode(groups, page, rule, node);
    }
  }
  return [...groups.values()];
}

function addNode(groups: Map<string, IssueGroup>, page: PageResult, rule: RuleResult, node: NodeResult) {
  let g = groups.get(node.groupId);
  if (!g) {
    g = {
      id: node.groupId,
      ruleId: rule.ruleId,
      impact: rule.impact,
      help: rule.help,
      description: rule.description,
      helpUrl: rule.helpUrl,
      wcag: rule.wcag,
      level: rule.level,
      principle: rule.principle,
      scored: isScored(rule.level),
      signature: node.signature,
      occurrences: 0,
      pageCount: 0,
      pages: [],
      patterns: [],
      examples: [],
      estimatedScoreGain: 0,
    };
    groups.set(node.groupId, g);
  }
  g.occurrences++;
  if (!g.pages.includes(page.path)) {
    g.pages.push(page.path);
    g.pageCount++;
  }
  const pattern = normalizeSelector(node.selector);
  if (g.patterns.length < MAX_PATTERNS && !g.patterns.includes(pattern)) g.patterns.push(pattern);
  if (g.examples.length < MAX_EXAMPLES && !g.examples.some((e) => e.page === page.path && e.selector === node.selector)) {
    g.examples.push({ page: page.path, selector: node.selector, html: node.html, failureSummary: node.failureSummary, data: node.data });
  }
}
