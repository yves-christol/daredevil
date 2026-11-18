import type { Page } from 'playwright';

/**
 * Cookie-consent dialogs cover the page and distort the audit (keyboard probe trapped
 * in the dialog, screenshots of the dialog, contrast checks blocked). We dismiss them
 * the way a privacy-minded user would: "reject" / "continue without accepting",
 * never "accept". With --keep-consent the dialog is left open and audited as-is
 * (useful to audit the consent dialog itself).
 */

/** Known CMP reject / continue-without-accepting controls, most specific first. */
const KNOWN_SELECTORS: { cmp: string; selector: string }[] = [
  { cmp: 'didomi', selector: '#didomi-notice-disagree-button' },
  { cmp: 'didomi', selector: '.didomi-continue-without-agreeing' },
  { cmp: 'onetrust', selector: '#onetrust-reject-all-handler' },
  { cmp: 'cookiebot', selector: '#CybotCookiebotDialogBodyButtonDecline' },
  { cmp: 'axeptio', selector: '#axeptio_btn_dismiss' },
  { cmp: 'tarteaucitron', selector: '#tarteaucitronAllDenied2' },
  { cmp: 'usercentrics', selector: '[data-testid="uc-deny-all-button"]' },
  { cmp: 'quantcast', selector: '.qc-cmp2-summary-buttons button[mode="secondary"]' },
  { cmp: 'trustarc', selector: '#truste-consent-required' },
  { cmp: 'complianz', selector: '.cmplz-deny' },
  { cmp: 'iubenda', selector: '.iubenda-cs-reject-btn' },
];

/** Fallback: visible buttons/links whose text means "reject" in French or English. */
const REJECT_TEXT =
  /^\s*(continuer sans accepter|tout refuser|refuser( tout| les cookies)?|je refuse|reject( all)?|decline( all)?|deny( all)?|only (necessary|essential)( cookies)?|necessary cookies only|use necessary cookies only)\s*[→>]?\s*$/i;

export interface ConsentResult {
  dismissed: boolean;
  method?: string;
}

/**
 * Wait briefly for a consent dialog and dismiss it. CMPs load asynchronously,
 * so poll for up to `maxWaitMs`. Returns what was clicked, if anything.
 */
export async function dismissConsent(page: Page, customSelector?: string, maxWaitMs = 4000): Promise<ConsentResult> {
  const deadline = Date.now() + maxWaitMs;
  const candidates = customSelector ? [{ cmp: 'custom', selector: customSelector }, ...KNOWN_SELECTORS] : KNOWN_SELECTORS;

  while (Date.now() < deadline) {
    for (const { cmp, selector } of candidates) {
      const loc = page.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) {
        if (await clickAndSettle(page, loc)) return { dismissed: true, method: `${cmp}: ${selector}` };
      }
    }
    // Generic text match, restricted to elements likely to be in a consent UI.
    const generic = page
      .locator('button, a, [role=button]')
      .filter({ hasText: REJECT_TEXT })
      .filter({ visible: true })
      .first();
    if (await generic.count().catch(() => 0)) {
      const text = ((await generic.textContent().catch(() => '')) ?? '').trim();
      if (await clickAndSettle(page, generic)) return { dismissed: true, method: `text: "${text}"` };
    }
    await page.waitForTimeout(250);
  }
  return { dismissed: false };
}

async function clickAndSettle(page: Page, loc: ReturnType<Page['locator']>): Promise<boolean> {
  try {
    await loc.click({ timeout: 2000 });
    await page.waitForTimeout(500); // closing animation
    return true;
  } catch {
    return false;
  }
}
