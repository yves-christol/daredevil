import type { Impact } from './types.ts';
import { faviconDataUri, logoInline } from './brand.ts';

/**
 * Building blocks shared by the report page (html.ts) and the batch page (batchhtml.ts):
 * escaping, score bands, ring / meter / badges, the agent-markdown subset, the page shell
 * (head, skip link, header with brand, nav and theme toggle) and the base stylesheet.
 * Design: docs/ux-guidelines.md.
 */

// Everything coming from the audited site (HTML snippets, selectors, alt text, titles)
// is untrusted: always go through esc(). Hrefs go through safeHref().

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const safeHref = (u: string): string => (/^https?:\/\//i.test(u) ? esc(u) : '#');

export const fmt = (n: number) => n.toLocaleString('en-US');
export const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export type Band = 'good' | 'fair' | 'poor' | 'bad';
export function band(score: number): Band {
  return score >= 90 ? 'good' : score >= 75 ? 'fair' : score >= 50 ? 'poor' : 'bad';
}
export const BAND_LABEL: Record<Band, string> = { good: 'Good', fair: 'Fair', poor: 'Poor', bad: 'Critical' };

// Status is never conveyed by colour alone: icon + text label on every badge.
export const IMPACT_ICON: Record<Impact, string> = { critical: '✕', serious: '!', moderate: '!', minor: 'i' };
export const impactBadge = (i: Impact | null | undefined) => {
  const v = i ?? 'moderate';
  return `<span class="badge impact-${v}"><span class="icon" aria-hidden="true">${IMPACT_ICON[v]}</span>${v}</span>`;
};
export const CONF_ICON: Record<string, string> = { high: '✓', medium: '~', low: '?' };
export const BAND_ICON: Record<Band, string> = { good: '✓', fair: '!', poor: '!', bad: '✕' };

export function ring(score: number, size = 168): string {
  const r = 70;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  const b = band(score);
  return `<svg class="ring band-${b}" width="${size}" height="${size}" viewBox="0 0 160 160" role="img" aria-label="Score ${score} out of 100, ${BAND_LABEL[b]}">
  <circle cx="80" cy="80" r="${r}" class="ring-track"/>
  <circle cx="80" cy="80" r="${r}" class="ring-value" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 80 80)"/>
  <text x="80" y="78" text-anchor="middle" class="ring-num">${score}</text>
  <text x="80" y="104" text-anchor="middle" class="ring-sub">/ 100</text>
</svg>`;
}

export function meter(label: string, score: number, note = ''): string {
  const b = band(score);
  return `<div class="meter">
  <div class="meter-head"><span>${esc(label)}${note ? ` <small>${esc(note)}</small>` : ''}</span><strong>${score}</strong></div>
  <div class="meter-bar" aria-hidden="true"><span class="band-${b}" style="width:${Math.max(0, Math.min(100, score))}%"></span></div>
</div>`;
}

/** Inline Markdown (code, bold, emphasis, links) on escaped text. */
export const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

/** Minimal Markdown → HTML for agent-written summaries: headings, lists, tables, emphasis, code, links. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  // The summary's top heading level becomes h3, under the page's own h2, whatever level the agent started at.
  let top = 6;
  let fenced = false;
  for (const l of lines) {
    if (/^```/.test(l)) fenced = !fenced;
    const m = !fenced && /^(#{1,6})\s/.exec(l);
    if (m) top = Math.min(top, m[1].length);
  }
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(6, h[1].length - top + 3);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      // Lists, with nesting by indentation.
      const stack: { indent: number; tag: string }[] = [];
      let html = '';
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i])!;
        const indent = m[1].length;
        const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        while (stack.length && indent < stack[stack.length - 1].indent) html += `</li></${stack.pop()!.tag}>`;
        if (!stack.length || indent > stack[stack.length - 1].indent) {
          html += `<${tag}>`;
          stack.push({ indent, tag });
        } else html += '</li>';
        html += `<li>${inline(m[3])}`;
        i++;
      }
      while (stack.length) html += `</li></${stack.pop()!.tag}>`;
      out.push(html);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ page shell

export interface PageOptions {
  title: string;
  /** Small muted text after "daredevil" in the header. */
  kicker: string;
  skip: { href: string; label: string };
  /** [href, label] */
  nav: [string, string][];
  navLabel?: string;
  /** Page-specific CSS, appended to the base stylesheet. */
  css?: string;
}

export function pageStart(o: PageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
${faviconDataUri() ? `<link rel="icon" href="${faviconDataUri()}">` : ''}
<script>try { var t = localStorage.getItem('dd-theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) {}</script>
<style>${BASE_CSS}${o.css ?? ''}</style>
</head>
<body>
<a class="skip" href="${esc(o.skip.href)}">${esc(o.skip.label)}</a>
<header class="top">
  <div class="wrap top-inner">
    <p class="brand">${logoInline()}<span>daredevil <span class="muted">${esc(o.kicker)}</span></span></p>
    ${o.nav.length ? `<nav aria-label="${esc(o.navLabel ?? 'Page sections')}"><ul>${o.nav.map(([href, label]) => `<li><a href="${esc(href)}">${esc(label)}</a></li>`).join('')}</ul></nav>` : '<span class="spacer"></span>'}
    <button type="button" class="theme-toggle" id="theme-toggle" hidden>Light theme</button>
  </div>
</header>
`;
}

/** Closes the page; `js` is page-specific script, run after the theme toggle. */
export function pageEnd(js = ''): string {
  return `<script>${THEME_JS}${js}</script>
</body>
</html>
`;
}

const THEME_JS = `
(function () {
  // Theme toggle: follows the OS preference until the reader picks one (remembered if storage works).
  var root = document.documentElement;
  var toggle = document.getElementById('theme-toggle');
  function current() {
    var t = root.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  function label() { toggle.textContent = current() === 'dark' ? 'Light theme' : 'Dark theme'; }
  if (toggle) {
    toggle.hidden = false;
    label();
    toggle.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('dd-theme', next); } catch (e) {}
      label();
    });
  }
})();
`;

export const BASE_CSS = `
/* Design tokens follow docs/ux-guidelines.md (dark = brand canvas), with the contrast
   corrections listed in its "Implementation notes". */
:root {
  color-scheme: dark;
  --bg: #18181b; --surface: #27272a; --sunken: #18181b; --text: #fafafa; --muted: #b4b4bb;
  --border: #3f3f46; --control: #71717a; --focus: #facc15; --on-focus: #18181b;
  --code-bg: #27272a; --code-border: #3f3f46; --link-line: #facc15;
  --bad: #f87171; --bad-fill: #ef4444; --poor: #fb923c; --fair: #fbbf24; --good: #4ade80; --minor: #d4d4d8;
  --badge-bg: transparent; --ring-track: #3f3f46; --layer: #3f3f46;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
    --bg: #f4f4f5; --surface: #ffffff; --sunken: #f4f4f5; --text: #18181b; --muted: #52525b;
    --border: #d4d4d8; --control: #71717a; --focus: #18181b; --on-focus: #ffffff;
    --code-bg: #f4f4f5; --code-border: #d4d4d8; --link-line: #18181b;
    --bad: #b91c1c; --bad-fill: #dc2626; --poor: #c2410c; --fair: #854d0e; --good: #15803d; --minor: #52525b;
    --ring-track: #e4e4e7; --layer: #d4d4d8;
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f4f4f5; --surface: #ffffff; --sunken: #f4f4f5; --text: #18181b; --muted: #52525b;
  --border: #d4d4d8; --control: #71717a; --focus: #18181b; --on-focus: #ffffff;
  --code-bg: #f4f4f5; --code-border: #d4d4d8; --link-line: #18181b;
  --bad: #b91c1c; --bad-fill: #dc2626; --poor: #c2410c; --fair: #854d0e; --good: #15803d; --minor: #52525b;
  --ring-track: #e4e4e7; --layer: #d4d4d8;
}
* { box-sizing: border-box; }
html { scroll-padding-top: 4.5rem; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 Inter, "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 0 16px; }
a { color: var(--text); text-decoration: underline; text-decoration-color: var(--link-line); text-decoration-thickness: 2px; text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 3px; }

/* Signature focus: the logo's 4-corner bracket reticle. The transparent outline keeps a
   visible indicator in forced-colors (Windows High Contrast) mode. */
:where(a, button, summary):focus-visible { outline: 2px solid transparent; outline-offset: 4px; position: relative; }
:where(a, button, summary):focus-visible::after {
  content: ""; position: absolute; inset: -5px; pointer-events: none; z-index: 1;
  --l: 10px; --w: 3px;
  background:
    linear-gradient(var(--focus) 0 0) top left / var(--l) var(--w) no-repeat,
    linear-gradient(var(--focus) 0 0) top left / var(--w) var(--l) no-repeat,
    linear-gradient(var(--focus) 0 0) top right / var(--l) var(--w) no-repeat,
    linear-gradient(var(--focus) 0 0) top right / var(--w) var(--l) no-repeat,
    linear-gradient(var(--focus) 0 0) bottom left / var(--l) var(--w) no-repeat,
    linear-gradient(var(--focus) 0 0) bottom left / var(--w) var(--l) no-repeat,
    linear-gradient(var(--focus) 0 0) bottom right / var(--l) var(--w) no-repeat,
    linear-gradient(var(--focus) 0 0) bottom right / var(--w) var(--l) no-repeat;
}

code, pre { font-family: "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { font-size: 13px; background: var(--code-bg); border: 1px solid var(--code-border); padding: .05em .4em; border-radius: 999px; overflow-wrap: anywhere; }
pre { font-size: 13px; background: var(--sunken); border: 1px solid var(--border); padding: .75rem 1rem; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
pre code { background: none; border: 0; padding: 0; border-radius: 0; }
.muted { color: var(--muted); }
.small { font-size: 14px; }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.skip { position: absolute; left: 16px; top: -100px; background: var(--focus); color: var(--on-focus); font-weight: 600; padding: .5rem 1rem; border-radius: 6px; z-index: 10; text-decoration: none; }
.skip:focus { top: 8px; }

.top { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--border); }
.top-inner { display: flex; align-items: center; gap: 1.25rem; min-height: 3.5rem; flex-wrap: wrap; }
.brand { margin: 0; font-weight: 600; letter-spacing: -.01em; display: flex; align-items: center; gap: .55rem; }
.brand svg { width: 28px; height: 28px; flex: none; }
.top nav { flex: 1; }
.top nav ul { display: flex; gap: .15rem; list-style: none; margin: 0; padding: 0; flex-wrap: wrap; }
.top nav a { display: block; padding: .3rem .6rem; border-radius: 6px; text-decoration: none; color: var(--muted); font-size: 14px; }
.top nav a:hover { color: var(--text); background: var(--surface); }
.theme-toggle { font: inherit; font-size: 14px; color: var(--text); background: transparent; border: 1px solid var(--control); border-radius: 999px; padding: .25rem .8rem; cursor: pointer; }

section { margin: 2.5rem 0; }
h1 { font-size: 24px; font-weight: 600; line-height: 1.2; margin: 0 0 .4rem; letter-spacing: -.02em; overflow-wrap: break-word; }
h2 { font-size: 16px; font-weight: 600; margin: 0 0 .5rem; letter-spacing: -.005em; }
h3 { font-size: 15px; font-weight: 600; margin: 1.2rem 0 .4rem; }
h4 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 1rem 0 .4rem; }
.lede { color: var(--muted); margin: 0 0 1rem; max-width: 70ch; }
.count { display: inline-block; font-size: 13px; font-weight: 600; border: 1px solid var(--border); color: var(--muted); border-radius: 999px; padding: 0 .5rem; vertical-align: 1px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem 1.5rem; }

.hero { display: grid; grid-template-columns: 1.3fr auto 1fr; gap: 2rem; align-items: center; background: var(--surface); border: 2px solid var(--border); border-radius: 16px; padding: 2rem; margin-top: 1.5rem; }
.hero-score { text-align: center; }
.hero-score p { margin: .2rem 0; }
.band-label { font-weight: 700; font-size: 15px; text-transform: uppercase; letter-spacing: .05em; }
.stats { list-style: none; padding: 0; margin: 1.25rem 0 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .75rem; }
.stats li { background: var(--sunken); border: 1px solid var(--border); border-radius: 10px; padding: .6rem .75rem; }
.stats strong { display: block; font-size: 22px; line-height: 1.2; font-weight: 600; font-variant-numeric: tabular-nums; }
.stats span { color: var(--muted); font-size: 14px; }
.handoff { margin: 1rem 0 0; color: var(--muted); }
.ring-track { fill: none; stroke: var(--ring-track); stroke-width: 14; }
.ring-value { fill: none; stroke-width: 14; stroke-linecap: round; }
.ring.band-bad .ring-value { stroke: var(--bad-fill); } .ring.band-poor .ring-value { stroke: var(--poor); }
.ring.band-fair .ring-value { stroke: var(--fair); } .ring.band-good .ring-value { stroke: var(--good); }
.ring-num { font-size: 40px; font-weight: 700; fill: var(--text); letter-spacing: -1px; font-family: Inter, system-ui, sans-serif; }
.ring-sub { font-size: 14px; fill: var(--muted); }
.band-text-bad { color: var(--bad); } .band-text-poor { color: var(--poor); } .band-text-fair { color: var(--fair); } .band-text-good { color: var(--good); }

.meter { margin: 0 0 .55rem; }
.meter-head { display: flex; justify-content: space-between; font-size: 14px; }
.meter-head small { color: var(--muted); font-size: 13px; }
.meter-bar { height: 8px; background: var(--ring-track); border-radius: 999px; overflow: hidden; margin-top: .2rem; }
.meter-bar span { display: block; height: 100%; border-radius: 999px; }
.meter-bar .band-bad { background: var(--bad-fill); } .meter-bar .band-poor { background: var(--poor); }
.meter-bar .band-fair { background: var(--fair); } .meter-bar .band-good { background: var(--good); }

/* Status never by colour alone: every badge carries an icon and a text label. */
.badge { display: inline-flex; align-items: center; gap: .3em; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; border: 1px solid currentColor; border-radius: 6px; padding: .05rem .45rem; vertical-align: 1px; background: var(--badge-bg); }
.badge .icon { font-weight: 800; }
.impact-critical { color: var(--bad); } .impact-serious { color: var(--poor); } .impact-moderate { color: var(--fair); } .impact-minor { color: var(--minor); }
.conf-high { color: var(--good); } .conf-medium { color: var(--fair); } .conf-low { color: var(--minor); }
.pill { display: inline-block; min-width: 3.2rem; text-align: center; font-weight: 700; border: 1px solid currentColor; border-radius: 999px; padding: 0 .5rem; font-size: 14px; font-variant-numeric: tabular-nums; }
.pill.band-bad { color: var(--bad); } .pill.band-poor { color: var(--poor); } .pill.band-fair { color: var(--fair); } .pill.band-good { color: var(--good); }

.table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
details .table-wrap { margin-top: .8rem; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: .55rem .8rem; border-bottom: 1px solid var(--border); vertical-align: top; }
thead th { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); background: var(--sunken); }
tbody tr:last-child > * { border-bottom: none; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
td.up, .delta.up span { color: var(--good); } td.down, .delta.down span { color: var(--bad); }
.warn-cell, .warn-text { color: var(--poor); font-weight: 600; }
.delta { font-size: 22px; margin: .2rem 0 .8rem; }
.warn { border: 1px solid var(--fair); color: var(--text); border-radius: 8px; padding: .5rem .8rem; }
.cols3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.5rem; }
.plain { list-style: none; padding: 0; margin: 0; font-size: 14px; display: grid; gap: .3rem; }
.ok-icon { color: var(--good); font-weight: 800; } .ko-icon { color: var(--bad); font-weight: 800; }

.prose { max-width: 78ch; }
.prose.card { max-width: none; }
.prose h3, .prose h4 { text-transform: none; letter-spacing: normal; color: var(--text); font-size: 15px; }
.prose li { margin: .25rem 0; }
.prose .table-wrap { margin: .8rem 0; }
details.card > summary { cursor: pointer; font-weight: 600; }

@media (max-width: 900px) {
  .hero { grid-template-columns: 1fr; padding: 1.25rem; }
  .hero-score { order: -1; }
  .cols3 { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .top nav { display: none; }
  .top-inner { justify-content: space-between; }
  .brand .muted { display: none; }
}
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
@media print {
  .top, .skip, .theme-toggle, .js-only { display: none; }
  :root { color-scheme: light; --bg: #fff; --surface: #fff; --sunken: #f4f4f5; --text: #000; --muted: #3f3f46; --border: #a1a1aa; --layer: #d4d4d8;
    --bad: #b91c1c; --bad-fill: #dc2626; --poor: #c2410c; --fair: #854d0e; --good: #15803d; --minor: #3f3f46; --link-line: #000; --code-bg: #f4f4f5; --code-border: #d4d4d8; }
}
.spacer { flex: 1; }
`;
