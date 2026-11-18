import type { Page } from 'playwright';
import type { ImageInfo, KeyboardProbe } from './types.ts';

const MAX_TABS = 80;

/**
 * Heuristic keyboard probe (assisted, not scored): tabs through the page and flags
 * elements whose focused style is identical to their unfocused style, plus focus traps.
 */
export async function keyboardProbe(page: Page): Promise<KeyboardProbe> {
  const tabbableElements = await page.evaluate(() => {
    const sel =
      'a[href], button, input:not([type=hidden]), select, textarea, summary, iframe, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable=true]';
    // NB: no named functions in page-evaluated code: tsx/esbuild would inject a
    // `__name` helper that does not exist in the browser.
    const w = window as unknown as { __ddStyles: WeakMap<Element, string> };
    w.__ddStyles = new WeakMap();
    const els = [...document.querySelectorAll(sel)].filter((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !(el as HTMLButtonElement).disabled;
    });
    for (const el of els) {
      const s = getComputedStyle(el);
      w.__ddStyles.set(el, [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|'));
    }
    (document.activeElement as HTMLElement | null)?.blur();
    return els.length;
  });

  const noVisibleFocus: KeyboardProbe['noVisibleFocus'] = [];
  const seen = new Set<string>();
  let tabStops = 0;
  let firstStop: string | undefined;
  let hasSkipLink = false;
  let possibleTrap: string | undefined;
  let last = '';
  let repeats = 0;

  for (let i = 0; i < Math.min(MAX_TABS, tabbableElements + 5); i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(30); // let focus transitions settle
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const s = getComputedStyle(el);
      const now = [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|');
      const w = window as unknown as { __ddStyles: WeakMap<Element, string> };
      const before = w.__ddStyles.get(el);
      const path: string[] = [];
      for (let n: Element | null = el; n && n !== document.body && path.length < 4; n = n.parentElement) {
        let p = n.tagName.toLowerCase();
        if (n.id) p += `#${n.id}`;
        else if (n.classList.length) p += '.' + [...n.classList].slice(0, 2).join('.');
        path.unshift(p);
      }
      const visibleOutline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
      return {
        selector: path.join(' > '),
        html: el.outerHTML.slice(0, 200),
        href: el.getAttribute('href') ?? '',
        unchanged: before !== undefined && before === now && !visibleOutline,
      };
    });
    if (!info) {
      if (tabStops > 0) break; // focus left the document: full cycle done
      continue;
    }
    tabStops++;
    if (!firstStop) {
      firstStop = info.selector;
      hasSkipLink = info.href.startsWith('#') && info.href.length > 1;
    }
    if (info.selector === last) {
      if (++repeats >= 3) {
        possibleTrap = info.selector;
        break;
      }
    } else repeats = 0;
    last = info.selector;
    if (seen.has(info.selector + info.html)) break; // wrapped around
    seen.add(info.selector + info.html);
    if (info.unchanged && noVisibleFocus.length < 15) noVisibleFocus.push({ selector: info.selector, html: info.html });
  }
  return { tabStops, tabbableElements, firstStop, hasSkipLink, noVisibleFocus, possibleTrap };
}

/** Inventory of images with alt text, with element screenshots so an AI can judge alt quality. */
export async function imageInventory(page: Page, assetDir: string, assetPrefix: string, max = 6): Promise<ImageInfo[]> {
  const handles = await page.$$('img[alt]:not([alt=""]), [role=img][aria-label]');
  const out: ImageInfo[] = [];
  for (const h of handles) {
    if (out.length >= max) break;
    const box = await h.boundingBox().catch(() => null);
    if (!box || box.width < 24 || box.height < 24) continue;
    const meta = await h.evaluate((el) => ({
      src: (el as HTMLImageElement).currentSrc || el.getAttribute('src') || '',
      alt: el.getAttribute('alt') ?? el.getAttribute('aria-label') ?? '',
      selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : ''),
    }));
    const file = `${assetPrefix}-img${out.length + 1}.png`;
    let screenshot: string | undefined;
    try {
      await h.screenshot({ path: `${assetDir}/${file}`, timeout: 5000 });
      screenshot = `assets/${file}`;
    } catch {
      /* off-screen or detached: keep metadata only */
    }
    out.push({ ...meta, screenshot });
  }
  return out;
}
