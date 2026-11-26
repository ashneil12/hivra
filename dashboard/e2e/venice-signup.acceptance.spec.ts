/**
 * Venice signup acceptance — restricted-mode Clerk proof without provisioning.
 *
 * One disposable +clerk_test user starts at /venice, follows the exact promo
 * claim handoff, accepts a unique no-mail Clerk invitation through the real
 * public sign-up UI, and lands authenticated on the exact Venice Launch deep
 * link. It deliberately stops there: no final launch action, no VM, no inference
 * and no standing account. The returned signup/user id boundary is kept explicit
 * so a separately gated credit + first-reply leg can continue from the same
 * helper and use launch-sweep/plan.ts for its Pro-plan fixture.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { assertNotProduction, auditEmail, AUDIT_EMAIL_DOMAIN, newRunId } from './first-run-audit/config';
import { deleteAuditUser } from './first-run-audit/clerk-admin';
import { createAuditBrowserContext } from './first-run-audit/session';
import { acceptAuditInvitation, type ClerkSignupUiResult } from './first-run-audit/signup';

const ENABLED = process.env.VENICE_SIGNUP_ACCEPTANCE === '1';
const HERMES_LAUNCH = '/dashboard/launch?agent=hermes&inference=venice&ref=venice';
const CLAIM_LAUNCH = `${HERMES_LAUNCH}&code=VENICE`;
const CLAIM_HREF = `/sign-up?redirect_url=${encodeURIComponent(CLAIM_LAUNCH)}`;

function env() {
  const baseUrl = (process.env.VENICE_SIGNUP_BASE_URL || process.env.E2E_BASE_URL || 'https://canary.hermesos.cloud').replace(/\/$/, '');
  assertNotProduction(baseUrl);
  const clerkSecretKey = process.env.CLERK_SECRET_KEY?.trim() ?? '';
  return { baseUrl, clerkSecretKey, runId: newRunId() };
}

type VeniceSignup = {
  context: BrowserContext;
  page: Page;
  signup: ClerkSignupUiResult & { invitation: { id: string } };
};

/** Factored at the exact handoff boundary a future credit/first-reply leg can reuse without re-proving signup. */
async function signUpThroughVeniceClaim(browser: Browser, baseUrl: string, clerkSecretKey: string, email: string): Promise<VeniceSignup> {
  const context = await createAuditBrowserContext(browser, { baseUrl });
  const page = await context.newPage();

  await page.goto('/venice', { waitUntil: 'domcontentloaded' });
  const claim = page.locator('[data-cta="venice-promo-claim"]');
  await expect(claim).toHaveAttribute('href', CLAIM_HREF);
  await claim.click();

  await expect(page).toHaveURL(/\/sign-up(?:\/|$|\?)/);
  const authUrl = new URL(page.url());
  expect(authUrl.searchParams.get('redirect_url')).toBe(CLAIM_LAUNCH);

  const signup = await acceptAuditInvitation(page, {
    baseUrl,
    clerkSecretKey,
    email,
    redirectPath: CLAIM_LAUNCH,
  });
  return { context, page, signup };
}

test.describe('Venice invitation signup acceptance', () => {
  test.skip(!ENABLED, 'VENICE_SIGNUP_ACCEPTANCE=1 is required: creates and deletes one disposable Canary Clerk user.');

  test('claim signup preserves the exact authenticated Venice Launch handoff', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const { baseUrl, clerkSecretKey, runId } = env();
    const email = auditEmail(`venice-signup-${runId}`, AUDIT_EMAIL_DOMAIN);
    let context: BrowserContext | null = null;
    let userId: string | null = null;

    try {
      const journey = await signUpThroughVeniceClaim(browser, baseUrl, clerkSecretKey, email);
      context = journey.context;
      userId = journey.signup.userId;

      const finalUrl = new URL(journey.page.url());
      const expectedUrl = new URL(CLAIM_LAUNCH, baseUrl);
      expect(finalUrl.pathname).toBe(expectedUrl.pathname);
      for (const [key, value] of expectedUrl.searchParams.entries()) {
        expect(finalUrl.searchParams.get(key), `redirect parameter ${key}`).toBe(value);
      }
      expect(journey.signup.otpUsed).toBe(false);

      // The authenticated handoff is the Launch plan itself, already on the
      // Venice-managed model lane. Do not press the final launch action: this leg creates no VM.
      await expect(
        journey.page.getByRole('heading', { name: /^Review and launch Hermes 1$/ }),
        'signup should land in the authenticated Venice Launch handoff',
      ).toBeVisible({ timeout: 60_000 });
      const credits = journey.page.getByRole('group', { name: 'Model access' }).getByRole('button', { name: /^Hivra credits/ });
      await expect(credits).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await context?.close().catch(() => undefined);
      if (userId) await deleteAuditUser(clerkSecretKey, userId, { verifyDeletion: true });
    }
  });
});
