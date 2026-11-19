const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|avif|ico|zip|gz|mp4|webm|mp3|wav|docx?|xlsx?|pptx?|csv|css|js|mjs|json|xml|txt|woff2?|ttf)$/i;

/** Canonical form used for dedupe: no hash, no trailing slash, optionally no query. */
export function normalizeUrl(raw: string, keepQuery: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  if (!keepQuery) u.search = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export interface Scope {
  origin: string;
  pathPrefix: string;
}

/** "/shop" matches "/shop" and "/shop/..." but not "/shopping". */
export function inScope(url: string, scope: Scope): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.origin !== scope.origin) return false;
  if (SKIP_EXT.test(u.pathname)) return false;
  const prefix = scope.pathPrefix.replace(/\/$/, '');
  if (prefix === '') return true;
  return u.pathname === prefix || u.pathname.startsWith(prefix + '/');
}

/** Index of the first scope containing `url`, or -1. */
export function scopeIndex(url: string, scopes: Scope[]): number {
  return scopes.findIndex((s) => inScope(url, s));
}

export function scopeFromUrl(startUrl: string): Scope {
  const u = new URL(startUrl);
  let path = u.pathname;
  // A start URL pointing at a document (/shop/index.html) scopes to its directory.
  if (/\/[^/]*\.[a-z0-9]+$/i.test(path)) path = path.replace(/\/[^/]*$/, '');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return { origin: u.origin, pathPrefix: path === '/' || path === '' ? '' : path };
}

/** Path (+ query) of a page; with `withHost` (audits spanning several hosts), prefixed by the host. */
export function pathOf(url: string, withHost = false): string {
  const u = new URL(url);
  return (withHost ? u.host : '') + u.pathname + u.search;
}

/**
 * The start URLs and scopes of an audit. `startUrls` / `scopes` exist only when an audit has
 * several start URLs (one combined report); `startUrl` / `scope` are then the first ones.
 */
export const startUrlsOf = (c: { startUrl: string; startUrls?: string[] }) => c.startUrls ?? [c.startUrl];
export const scopesOf = (c: { scope: Scope; scopes?: Scope[] }) => c.scopes ?? [c.scope];

/** Scope as text: "host/path", several joined with " + ". */
export const scopeText = (s: Scope) => s.origin.replace(/^https?:\/\//, '') + s.pathPrefix;
export const scopesLabel = (c: { scope: Scope; scopes?: Scope[] }) => scopesOf(c).map(scopeText).join(' + ');

/** True when the scopes span several origins: page paths then carry the host. */
export const multiOrigin = (scopes: Scope[]) => new Set(scopes.map((s) => s.origin)).size > 1;

/** True when every page of `inner` is also in `outer` (including the same scope). */
export const covers = (outer: Scope, inner: Scope) =>
  outer.origin === inner.origin && (outer.pathPrefix === '' || inner.pathPrefix === outer.pathPrefix || inner.pathPrefix.startsWith(outer.pathPrefix + '/'));

/** The URLs whose scope no other URL covers (of two identical scopes, the first is kept). */
export function outermost(urls: string[]): string[] {
  const scopes = urls.map(scopeFromUrl);
  return urls.filter((_, i) => !scopes.some((o, j) => j !== i && covers(o, scopes[i]) && (scopeText(o) !== scopeText(scopes[i]) || j < i)));
}

/**
 * Problems with a set of start URLs: the same scope twice, or one scope inside another
 * (its pages would already be crawled by the outer one). Empty when fine.
 */
export function scopeConflicts(urls: string[]): string[] {
  const scopes = urls.map(scopeFromUrl);
  const out: string[] = [];
  for (let i = 0; i < scopes.length; i++)
    for (let j = i + 1; j < scopes.length; j++) {
      const [a, b] = [scopes[i], scopes[j]];
      if (scopeText(a) === scopeText(b)) out.push(`${urls[i]} and ${urls[j]} are the same scope (${scopeText(a)}): keep one`);
      else if (covers(a, b)) out.push(`${urls[j]} is inside ${urls[i]} (already crawled by it): keep ${urls[i]}`);
      else if (covers(b, a)) out.push(`${urls[i]} is inside ${urls[j]} (already crawled by it): keep ${urls[j]}`);
    }
  return out;
}
