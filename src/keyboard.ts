import type { PageResult } from './types.ts';
import { MAX_TABS } from './probes.ts';

/**
 * Plain-language reading of the keyboard probe (heuristic, not scored), shared by
 * report.html and report.md: one verdict per check, with why it matters and what to do.
 * Texts use Markdown inline code (backticks); HTML renders them with `inline()`.
 * Thresholds match the fix prompt's keyboard signals (src/fixprompt.ts).
 */

export type KbCheckId = 'reach' | 'skip' | 'focus' | 'trap';

export interface KbCheck {
  id: KbCheckId;
  /** The question the check answers, in user terms. */
  question: string;
  ok: boolean;
  /** What the probe found, with counts. */
  finding: string;
  /** Who is affected and why it matters. */
  why: string;
  /** What to check or change. Empty when ok. */
  todo: string;
  /** Pages concerned (paths), and elements when relevant. */
  pages: string[];
  elements?: { page: string; selector: string; html: string }[];
}

/** Pages with enough controls for a missing skip link to matter (same as the fix prompt). */
export const SKIP_LINK_MIN_TABBABLE = 20;

export const lowReach = (k: NonNullable<PageResult['keyboard']>): boolean =>
  !k.capped && k.tabbableElements > 10 && k.tabStops < k.tabbableElements * 0.5;

const IFRAME = /(^|[\s>])iframe([#.\s]|$)/;
const IFRAME_NOTE =
  ' When the element is an `<iframe>` (an embedded chat, video or map), the probe cannot see inside it: focus is probably moving through the iframe’s own content, so this is often a false alarm. Check by hand.';

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function keyboardChecks(pages: PageResult[]): KbCheck[] {
  const kb = pages.filter((p) => p.keyboard);
  const n = kb.length;
  const all = n === 1 ? 'the page' : `all ${n} pages`;

  const low = kb.filter((p) => lowReach(p.keyboard!));
  const capped = kb.filter((p) => p.keyboard!.capped);
  const reach: KbCheck = {
    id: 'reach',
    question: 'Can every control be reached with the Tab key?',
    ok: low.length === 0,
    finding: low.length
      ? `On ${plural(low.length, 'page')} of ${n}, Tab reached fewer than half of the links, buttons and fields found on the page.`
      : `On ${all}, Tab reached most of the links, buttons and fields found on the page.` +
        (capped.length ? ` On ${plural(capped.length, 'page')} the probe stopped after ${MAX_TABS} presses: that is its limit, not a defect.` : ''),
    why: 'People who cannot use a mouse (motor disabilities, tremors, screen-reader users, many power users) move through a page with Tab. A control Tab never reaches is a control they cannot use.',
    todo: low.length
      ? 'Often harmless: items of closed menus or carousels are counted but rightly skipped. Open the page, press Tab repeatedly and check that every visible button, link and field gets focus. Clickable elements built from `<div>` or `<span>` need to become real `<button>` or `<a href>` elements.'
      : '',
    pages: low.map((p) => p.path),
  };

  const big = kb.filter((p) => p.keyboard!.tabbableElements > SKIP_LINK_MIN_TABBABLE);
  const noSkip = big.filter((p) => !p.keyboard!.hasSkipLink);
  const skip: KbCheck = {
    id: 'skip',
    question: 'Can keyboard users jump past the menu to the content?',
    ok: noSkip.length === 0,
    finding: !big.length
      ? 'No page has enough links for a “skip to content” link to matter.'
      : noSkip.length === big.length && big.length > 1
        ? `None of the ${big.length} pages with many links starts with a “skip to content” link.`
        : noSkip.length
          ? `${plural(noSkip.length, 'page')} of ${big.length} with many links ${noSkip.length === 1 ? 'has' : 'have'} no “skip to content” link as the first Tab stop.`
        : `Every page with many links starts with a “skip to content” link.`,
    why: 'Without a skip link, keyboard and screen-reader users must Tab through the whole header and menu on every page before reaching the content: dozens of key presses each time.',
    todo: noSkip.length
      ? 'Add a link as the very first element of the page, e.g. `<a href="#main">Skip to content</a>`, pointing to the main content (`<main id="main">`). It may stay hidden until it receives focus, but must then become visible.' +
        (noSkip.length > 1 ? ' When many pages lack it, this is usually one change in the shared page template.' : '')
      : '',
    // All pages concerned: the finding says so, a full list adds nothing.
    pages: noSkip.length === big.length && big.length > 1 ? [] : noSkip.map((p) => p.path),
  };

  const nf = kb.filter((p) => p.keyboard!.noVisibleFocus.length);
  const nfCount = nf.reduce((a, p) => a + p.keyboard!.noVisibleFocus.length, 0);
  const focus: KbCheck = {
    id: 'focus',
    question: 'Can you see which element has the focus?',
    ok: nfCount === 0,
    finding: nfCount
      ? `${plural(nfCount, 'element')} on ${plural(nf.length, 'page')} looked exactly the same with and without keyboard focus.`
      : 'Every element reached by Tab changed its appearance when focused.',
    why: 'The focus indicator is the keyboard user’s mouse pointer. Without it, they press Tab and no longer know where they are, and Enter activates something they cannot see.',
    todo: nfCount
      ? 'Do not remove the browser outline (`outline: none`) without a replacement. Give interactive elements a clearly visible `:focus-visible` style, e.g. `outline: 2px solid` with enough contrast against the background. Check: press Tab and watch each element listed below.' +
        (nf.some((p) => p.keyboard!.noVisibleFocus.some((e) => IFRAME.test(e.selector))) ? IFRAME_NOTE : '')
      : '',
    pages: nf.map((p) => p.path),
    elements: nf.flatMap((p) => p.keyboard!.noVisibleFocus.map((e) => ({ page: p.path, ...e }))),
  };

  const traps = kb.filter((p) => p.keyboard!.possibleTrap);
  const trap: KbCheck = {
    id: 'trap',
    question: 'Can you always move on with Tab?',
    ok: traps.length === 0,
    finding: traps.length
      ? `On ${plural(traps.length, 'page')}, focus stopped moving on one element although Tab kept being pressed.`
      : 'Focus never got stuck on an element.',
    why: 'A keyboard trap is the worst keyboard defect: the user cannot leave the element (often an embedded player, map or widget) and is stuck on the page. WCAG 2.1.2 forbids it.',
    todo: traps.length
      ? 'Try it by hand: Tab to the element, then press Tab, Shift+Tab and Escape. If focus cannot leave it, fix the script that intercepts the Tab key. Modal dialogs may keep focus inside on purpose, as long as Escape or a close button gets out.' +
        (traps.some((p) => IFRAME.test(p.keyboard!.possibleTrap!)) ? IFRAME_NOTE : '')
      : '',
    pages: traps.map((p) => `${p.path} (${p.keyboard!.possibleTrap})`),
  };

  return [trap, focus, reach, skip];
}
