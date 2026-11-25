/**
 * Turns a Clerk test-mode email-code sign-in into a live, authenticated browser
 * context. The account address must be a +clerk_test address; in a test-mode
 * Clerk instance Clerk suppresses mail to it and accepts the fixed test OTP.
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
  assertClerkTestAuditEmail,
  assertLiveManagedHostingAuditAllowed,
  assertNotProduction,
  CLERK_TEST_OTP_CODE,
} from './config';
import {
  applyHumanBrowserSignals,
  humanBrowserContextOptions,
} from './browser-signals';

// Imported from app source, not re-declared: if the app renames the key or bumps
// the consent version, this harness breaks loudly instead of silently capturing
// nothing. (cookie-consent.ts has no imports of its own — safe to pull in.)
import { CONSENT_STORAGE_KEY, CONSENT_VERSION } from '../../src/lib/consent/cookie-consent';

/** Minimal shape of the Clerk client we touch. Types erase at runtime. */
type ClerkSignInResource = {
  createdSessionId: string | null;
  status?: string;
  supportedFirstFactors?: Array<{ strategy?: string; emailAddressId?: string }>;
  prepareFirstFactor(o: { strategy: 'email_code'; emailAddressId: string }): Promise<unknown>;
  attemptFirstFactor(o: { strategy: 'email_code'; code: string }): Promise<ClerkSignInResource>;
};

type ClerkWin = {
  Clerk?: {
    loaded?: boolean;
    client: {
      signIn: {
        create(o: { identifier: string }): Promise<ClerkSignInResource>;
      };
    };
    setActive(o: { session: string }): Promise<void>;
  };
};

export interface SessionOptions {
  baseUrl: string;
  email: string;
  /** Attach network listeners etc. before the first navigation. */
  onContext?: (context: BrowserContext) => void | Promise<void>;
}

/**
 * Creates a fresh context (no storage state — a virgin browser for a virgin
 * user), grants analytics consent, completes Clerk's email-code sign-in, and
 * lands on /dashboard so the session cookie is fully established.
 */
export async function establishAuditSession(
  browser: Browser,
  { baseUrl, email, onContext }: SessionOptions,
): Promise<BrowserContext> {
  assertLiveManagedHostingAuditAllowed();
  assertNotProduction(baseUrl);
  assertClerkTestAuditEmail(email);
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
    await page.evaluate(async ({ email, code }) => {
      const clerk = (window as unknown as ClerkWin).Clerk;
      if (!clerk) throw new Error('Clerk failed to load on /sign-in');
      const signIn = await clerk.client.signIn.create({ identifier: email });
      const emailFactor = signIn.supportedFirstFactors?.find((factor) => factor.strategy === 'email_code');
      if (!emailFactor?.emailAddressId) {
        throw new Error('Clerk did not offer email-code sign-in for the audit account');
      }
      await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: emailFactor.emailAddressId });
      const completed = await signIn.attemptFirstFactor({ strategy: 'email_code', code });
      if (!completed.createdSessionId) {
        throw new Error(`Clerk email-code sign-in did not complete (status ${completed.status ?? 'unknown'})`);
      }
      await clerk.setActive({ session: completed.createdSessionId });
    }, { email, code: CLERK_TEST_OTP_CODE });

    // Land authed so the session cookie is written for subsequent API calls.
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  } finally {
    await page.close();
  }

  return context;
}
