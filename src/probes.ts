import type { Page } from 'playwright';
import type { ImageInfo, KeyboardProbe } from './types.ts';

export const MAX_TABS = 80;

/**
 * Heuristic keyboard probe (assisted, not scored): tabs through the page and flags
 * elements whose focused style is identical to their unfocused style, plus focus traps.
 * Shadow DOM aware: web components (e.g. design-system headers) are traversed, and the
 * focused element is resolved through nested shadowRoot.activeElement.
 *
 * NB: no named functions in page-evaluated code: tsx/esbuild would inject a `__name`
 * helper that does not exist in the browser. Hence the explicit loops below.
 */
export async function keyboardProbe(page: Page): Promise<KeyboardProbe> {
  const tabbableElements = await page.evaluate(() => {
    const sel =
      'a[href], button, input:not([type=hidden]), select, textarea, summary, iframe, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable=true]';
    const w = window as unknown as { __dd: { styles: WeakMap<Element, string>; seen: WeakSet<Element>; last: Element | null } };
    w.__dd = { styles: new WeakMap(), seen: new WeakSet(), last: null };
    // Collect tabbable elements in the document and in every open shadow root.
    const roots: (Document | ShadowRoot)[] = [document];
    const els: Element[] = [];
    while (roots.length) {
      const root = roots.pop()!;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (!el.matches(sel)) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && !(el as HTMLButtonElement).disabled) els.push(el);
      }
    }
    for (const el of els) {
      const s = getComputedStyle(el);
      w.__dd.styles.set(el, [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|'));
    }
    (document.activeElement as HTMLElement | null)?.blur();
    return els.length;
  });

  const noVisibleFocus: KeyboardProbe['noVisibleFocus'] = [];
  let tabStops = 0;
  let firstStop: string | undefined;
  let hasSkipLink = false;
  let possibleTrap: string | undefined;
  let repeats = 0;
  let completed = false;
  const limit = Math.min(MAX_TABS, tabbableElements + 5);

  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(30); // let focus transitions settle
    const info = await page.evaluate(() => {
      let el: Element | null = document.activeElement;
      const hosts: string[] = [];
      while (el && el.shadowRoot && el.shadowRoot.activeElement) {
        hosts.push(el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''));
        el = el.shadowRoot.activeElement;
      }
      if (!el || el === document.body || el === document.documentElement) return null;
      const w = window as unknown as { __dd: { styles: WeakMap<Element, string>; seen: WeakSet<Element>; last: Element | null } };
      const same = w.__dd.last === el;
      const wrapped = !same && w.__dd.seen.has(el);
      w.__dd.last = el;
      w.__dd.seen.add(el);
      const s = getComputedStyle(el);
      const now = [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|');
      const before = w.__dd.styles.get(el);
      const path: string[] = [];
      for (let n: Element | null = el; n && n !== document.body && path.length < 4; n = n.parentElement) {
        let p = n.tagName.toLowerCase();
        if (n.id) p += `#${n.id}`;
        else if (n.classList.length) p += '.' + [...n.classList].slice(0, 2).join('.');
        path.unshift(p);
      }
      const visibleOutline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
      return {
        selector: (hosts.length ? hosts.join(' >>> ') + ' >>> ' : '') + path.join(' > '),
        html: el.outerHTML.slice(0, 200),
        href: el.getAttribute('href') ?? '',
        same,
        wrapped,
        unchanged: before !== undefined && before === now && !visibleOutline,
      };
    });
    if (!info) {
      if (tabStops > 0) {
        completed = true; // focus left the document: full cycle done
        break;
      }
      continue;
    }
    if (info.wrapped) {
      completed = true; // back to an element already visited: full cycle done
      break;
    }
    if (info.same) {
      if (++repeats >= 3) {
        possibleTrap = info.selector;
        completed = true;
        break;
      }
      continue;
    }
    repeats = 0;
    tabStops++;
    if (!firstStop) {
      firstStop = info.selector;
      hasSkipLink = info.href.startsWith('#') && info.href.length > 1;
    }
    if (info.unchanged && noVisibleFocus.length < 15) noVisibleFocus.push({ selector: info.selector, html: info.html });
  }
  const capped = !completed && limit === MAX_TABS;
  return { tabStops, capped, tabbableElements, firstStop, hasSkipLink, noVisibleFocus, possibleTrap };
}

/**
 * Inventory of images with alt text, so an AI can judge alt quality. With `screenshots`,
 * each image also gets an element screenshot; without (logged-in audits by default, since
 * account pages show personal data), only selector, src and alt are kept.
 */
export async function imageInventory(
  page: Page,
  screenshots?: { assetDir: string; assetPrefix: string },
  max = 6,
): Promise<ImageInfo[]> {
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
    let screenshot: string | undefined;
    if (screenshots) {
      const file = `${screenshots.assetPrefix}-img${out.length + 1}.png`;
      try {
        await h.screenshot({ path: `${screenshots.assetDir}/${file}`, timeout: 5000 });
        screenshot = `assets/${file}`;
      } catch {
        /* off-screen or detached: keep metadata only */
      }
    }
    out.push({ ...meta, screenshot });
  }
  return out;
}
