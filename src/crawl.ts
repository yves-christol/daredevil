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

/** "/shop" matches "/shop" and "/shop/..." but not "/shopping". */
export function inScope(url: string, scope: { origin: string; pathPrefix: string }): boolean {
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

export function scopeFromUrl(startUrl: string): { origin: string; pathPrefix: string } {
  const u = new URL(startUrl);
  let path = u.pathname;
  // A start URL pointing at a document (/shop/index.html) scopes to its directory.
  if (/\/[^/]*\.[a-z0-9]+$/i.test(path)) path = path.replace(/\/[^/]*$/, '');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return { origin: u.origin, pathPrefix: path === '/' || path === '' ? '' : path };
}

export function pathOf(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}
