/**
 * Turns a Clerk sign-in ticket into a live, authenticated browser context.
 *
 * TWO things must be true before posthog will capture a single event, and the
 * audit needs both or a failed run cannot tell us where it died:
 *
 *   1. CONSENT. PostHog is `opt_out_capturing_by_default: !consentGrantedAtInit`
 *      (PostHogProvider.tsx), so a stored "accepted" choice must exist before
 *      any page script runs.
 *
 *   2. NOT LOOKING LIKE A BOT. posthog-js silently drops every capture() from a
 *      browser whose UA / UA-CH brands / `navigator.webdriver` say "automation"
 *      — which is every stock Playwright context. See browser-signals.ts; that
 *      gate, NOT a missing analytics key, is why this harness recorded
 *      `posthog_captured: false` on canary.
 */
import type { Browser, BrowserContext } from '@playwright/test';

import {
  applyHumanBrowserSignals,
  humanBrowserContextOptions,
} from './browser-signals';

// Imported from app source, not re-declared: if the app renames the key or bumps
// the consent version, this harness breaks loudly instead of silently capturing
// nothing. (cookie-consent.ts has no imports of its own — safe to pull in.)
import { CONSENT_STORAGE_KEY, CONSENT_VERSION } from '../../src/lib/consent/cookie-consent';

/** Minimal shape of the Clerk client we touch. Types erase at runtime. */
type ClerkWin = {
  Clerk?: {
    loaded?: boolean;
    client: {
      signIn: {
        create(o: { strategy: 'ticket'; ticket: string }): Promise<{ createdSessionId: string }>;
      };
    };
    setActive(o: { session: string }): Promise<void>;
  };
};

export interface SessionOptions {
  baseUrl: string;
  ticket: string;
  /** Attach network listeners etc. before the first navigation. */
  onContext?: (context: BrowserContext) => void | Promise<void>;
}

/**
 * Creates a fresh context (no storage state — a virgin browser for a virgin
 * user), grants analytics consent, redeems the ticket, and lands on /dashboard
 * so the session cookie is fully established.
 */
export async function establishAuditSession(
  browser: Browser,
  { baseUrl, ticket, onContext }: SessionOptions,
): Promise<BrowserContext> {
  // NB: browser.newContext() does NOT inherit the project's `use` options, so
  // the UA here is the raw (headless) one unless we set it explicitly.
  const context = await browser.newContext({
    baseURL: baseUrl,
    ...(await humanBrowserContextOptions(browser)),
  });

  // Both init scripts run on every document, ahead of any page script.
  await applyHumanBrowserSignals(context);

  // Consent must exist before posthog.init() reads it.
  await context.addInitScript(
    ([key, version]) => {
      try {
        window.localStorage.setItem(
          key as string,
          JSON.stringify({ choice: 'accepted', version, timestamp: Date.now() }),
        );
      } catch {
        /* private mode — capture just stays off, the run still works */
      }
    },
    [CONSENT_STORAGE_KEY, CONSENT_VERSION] as const,
  );

  if (onContext) await onContext(context);

  const page = await context.newPage();
  try {
    await page.goto('/sign-in', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as ClerkWin).Clerk?.loaded, {
      timeout: 45_000,
    });
    await page.evaluate(async (t) => {
      const clerk = (window as unknown as ClerkWin).Clerk;
      if (!clerk) throw new Error('Clerk failed to load on /sign-in');
      const signIn = await clerk.client.signIn.create({ strategy: 'ticket', ticket: t });
      await clerk.setActive({ session: signIn.createdSessionId });
    }, ticket);

    // Land authed so the session cookie is written for subsequent API calls.
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  } finally {
    await page.close();
  }

  return context;
}
