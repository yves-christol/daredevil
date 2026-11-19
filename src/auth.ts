import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * Authenticated audits. The user logs in by hand in a headed browser (`daredevil login`),
 * so daredevil never sees credentials: only the resulting Playwright storage state
 * (cookies + localStorage) is saved, to a 0600 file under .auth/ (git-ignored).
 * Audits load that state into every page context (`--auth <file>`).
 */

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * Links never followed during an authenticated crawl: logout links (visiting them ends the
 * session) and account-changing flows seen in practice (removing a contract, confirmation
 * steps, changing bank details), which a crawl should not open even if a GET is harmless.
 */
export const LOGOUT_URL = /log-?out|log-?off|sign-?out|d[eé]connexion|d[eé]connecter|disconnect|retirer|confirmation|changer-iban/i;

/** Path segments that identify a login page on the audited origin. */
const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|connexion|se-connecter|authenticate|authentication|auth|identification|sso|oauth2?)(\/|\.|$)/i;

/**
 * True when `url` looks like the place a logged-out visitor is sent to: another origin
 * (e.g. login.orange.fr for espace-client.orange.fr) or a login-like path on the same origin.
 */
export function isLoginUrl(url: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.origin !== origin || LOGIN_PATH.test(u.pathname);
}

/** Same UA for login and audit, so the session is not rejected for a UA change. */
export async function defaultUserAgent(browser: Browser): Promise<string> {
  const probe = await browser.newPage();
  const ua = await probe.evaluate(() => navigator.userAgent);
  await probe.close();
  return ua.replace('HeadlessChrome', 'Chrome') + ' daredevil-a11y/0.1';
}

/** Default session file for a URL: .auth/<host>.json */
export function defaultStateFile(url: string, dir = '.auth'): string {
  return `${dir}/${new URL(url).host.replace(/[^a-zA-Z0-9.-]+/g, '_')}.json`;
}

/** Read and validate a storage-state file. Never logs its content. */
export async function loadAuthState(file: string): Promise<StorageState> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new Error(`session file not found: ${file}\nCreate it with: npm run -s login -- <url>`);
  }
  let state: StorageState;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error(`session file is not valid JSON: ${file}`);
  }
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    throw new Error(`not a Playwright storage-state file: ${file}`);
  }
  return state;
}

/** Cookies that would be sent to `url`'s host. */
function cookiesFor(state: StorageState, url: string) {
  const host = new URL(url).hostname;
  return state.cookies.filter((c) => {
    const d = c.domain.replace(/^\./, '');
    return host === d || host.endsWith('.' + d);
  });
}

/** One-line description of how long the session should last (from cookie expiry). */
export function sessionLifetime(state: StorageState, url: string, now = Date.now()): { text: string; expired: boolean } {
  const cookies = cookiesFor(state, url);
  if (cookies.length === 0) return { text: `no cookies for ${new URL(url).hostname}`, expired: false };
  const persistent = cookies.filter((c) => c.expires > 0);
  const live = persistent.filter((c) => c.expires * 1000 > now);
  const session = cookies.length - persistent.length;
  if (persistent.length > 0 && live.length === 0 && session === 0) return { text: 'all cookies have expired', expired: true };
  const parts = [`${cookies.length} cookie${cookies.length === 1 ? '' : 's'} for ${new URL(url).hostname}`];
  if (session) parts.push(`${session} session-only (valid until the server expires them)`);
  if (live.length) {
    const first = Math.min(...live.map((c) => c.expires * 1000));
    parts.push(`first expiry ${new Date(first).toISOString().replace(/\.\d+Z$/, 'Z')}`);
  }
  if (persistent.length > live.length) parts.push(`${persistent.length - live.length} already expired`);
  return { text: parts.join(', '), expired: false };
}

export interface CaptureOptions {
  url: string;
  out: string;
  /** CSS selector visible only when logged in: when it appears, the session is saved. */
  loggedInCheck?: string;
  headless?: boolean;
  /** Give up after this long (ms). */
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Tests only: drive the login form instead of a human. */
  interact?: (page: Page) => Promise<void>;
}

/**
 * Open `url` in a browser, let the user log in, save the storage state to `out`.
 * The session is saved when one of these happens:
 *  - the browser comes back to the audited origin after visiting a login page,
 *  - `loggedInCheck` becomes visible,
 *  - the user presses Enter in the terminal (if it is interactive), or closes the window
 *    (the last snapshot taken on the audited origin is kept).
 */
export async function captureSession(opts: CaptureOptions): Promise<{ file: string; finalUrl: string; reason: string; lifetime: string }> {
  const log = opts.log ?? (() => {});
  const origin = new URL(opts.url).origin;
  const browser = await chromium.launch({ headless: opts.headless ?? false });
  let rl: ReturnType<typeof createInterface> | undefined;
  try {
    const userAgent = await defaultUserAgent(browser);
    const context = await browser.newContext({ userAgent, viewport: null });
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: 'load', timeout: 60_000 }).catch(() => {});

    let done: string | undefined;
    let closed = false;
    page.on('close', () => (closed = true));
    if (process.stdin.isTTY && !opts.interact) {
      rl = createInterface({ input: process.stdin });
      rl.on('line', () => (done ??= 'enter pressed'));
      log('Log in in the browser window. The session is saved automatically once you are back on the site;');
      log('press Enter here to save it now, or close the window when done.');
    } else if (!opts.interact) {
      log('Log in in the browser window. The session is saved automatically once you are back on the site,');
      log('or when you close the window.');
    }
    const interaction = opts.interact?.(page).catch((e) => log(`interaction failed: ${(e as Error).message}`));

    let snapshot: StorageState | undefined;
    let snapshotUrl = opts.url;
    let sawLogin = false;
    /** Whether the snapshot was taken after the login page was seen. */
    let snapshotAfterLogin = false;
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    while (!done && !closed && Date.now() < deadline) {
      const url = page.url();
      if (isLoginUrl(url, origin)) {
        sawLogin = true;
      } else if (url.startsWith(origin)) {
        const ok = opts.loggedInCheck
          ? await page.locator(opts.loggedInCheck).first().isVisible().catch(() => false)
          : true;
        if (ok) {
          snapshot = await context.storageState().catch(() => snapshot);
          snapshotUrl = url;
          snapshotAfterLogin = sawLogin;
          if (sawLogin && !opts.loggedInCheck) {
            // Let post-login redirects and token exchanges finish, then take the final snapshot.
            await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
            if (!isLoginUrl(page.url(), origin)) {
              snapshot = await context.storageState().catch(() => snapshot);
              snapshotUrl = page.url();
              done = 'back on the site after logging in';
            }
          } else if (opts.loggedInCheck) {
            done = `found ${opts.loggedInCheck}`;
          }
        }
      }
      if (!done) await new Promise((r) => setTimeout(r, 500));
    }
    if (done === 'enter pressed' && !closed && page.url().startsWith(origin)) {
      snapshot = await context.storageState().catch(() => snapshot);
      snapshotUrl = page.url();
    }
    await interaction;
    if (!snapshot) {
      throw new Error(
        closed ? 'window closed before reaching the site while logged in: nothing saved' : 'timed out waiting for the login: nothing saved',
      );
    }
    if (!done && sawLogin && !snapshotAfterLogin) {
      throw new Error(`the browser did not come back to ${origin} after the login page: nothing saved. Run login again and, once logged in, open ${opts.url} in that window before closing it`);
    }
    const reason = done ?? (closed ? 'window closed' : 'timeout');

    const dir = opts.out.includes('/') ? opts.out.slice(0, opts.out.lastIndexOf('/')) : '.';
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(opts.out, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await chmod(opts.out, 0o600);
    return { file: opts.out, finalUrl: snapshotUrl, reason, lifetime: sessionLifetime(snapshot, opts.url).text };
  } finally {
    rl?.close();
    await browser.close();
  }
}
