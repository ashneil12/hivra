/**
 * TRIAL TO PRO: a new customer starts the 7-day card trial from the pricing
 * page, pays nothing at Stripe Checkout with a test card, gets the trial's small
 * pool, and becomes a full Pro account when the trial ends and the card is
 * charged. A second account with the same card gets no second trial.
 *
 * Canary only, Stripe test mode only, and opt-in: TRIAL_JOURNEY=1. Needs the
 * card trial switched on (HIVRA_CARD_TRIAL=on) and its migration on Canary.
 * Every account, subscription and trial record it makes is deleted at the end.
 *
 *   TRIAL_JOURNEY=1 CLERK_SECRET_KEY=sk_test_… LAUNCH_SWEEP_SUPABASE_URL=… \
 *     LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY=… TRIAL_JOURNEY_STRIPE_SECRET_KEY=sk_test_… \
 *     npm run test:trial-journey
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { assertNotProduction, auditEmail, newRunId } from './first-run-audit/config';
import { createAuditUser, deleteAuditUser, mintSignInTicket } from './first-run-audit/clerk-admin';
import { establishAuditSession } from './first-run-audit/session';
import { accountState, trialLengthOk, type SubscriptionRow } from './trial-to-pro/state';
import { assertTestKey, cancelSubscription, deleteCustomer, endTrialNow, getSubscription } from './trial-to-pro/stripe';

const ENABLED = process.env.TRIAL_JOURNEY === '1';
const TEST_CARD = process.env.TRIAL_JOURNEY_CARD?.trim() || '4242424242424242';

function journeyEnv() {
  const baseUrl = (process.env.TRIAL_JOURNEY_BASE_URL || process.env.E2E_BASE_URL || 'https://canary.hermesos.cloud').replace(/\/$/, '');
  assertNotProduction(baseUrl);
  const clerkSecretKey = process.env.CLERK_SECRET_KEY?.trim() ?? '';
  if (!clerkSecretKey.startsWith('sk_test_')) throw new Error('[trial-journey] CLERK_SECRET_KEY must be the Canary test key (sk_test_…).');
  const stripeKey = process.env.TRIAL_JOURNEY_STRIPE_SECRET_KEY?.trim() ?? '';
  assertTestKey(stripeKey);
  const supabaseUrl = (process.env.LAUNCH_SWEEP_SUPABASE_URL ?? '').replace(/\/$/, '');
  const serviceRoleKey = process.env.LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceRoleKey) throw new Error('[trial-journey] LAUNCH_SWEEP_SUPABASE_URL and LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY are required.');
  return { baseUrl, clerkSecretKey, stripeKey, supabaseUrl, serviceRoleKey, runId: process.env.TRIAL_JOURNEY_RUN_ID?.trim() || newRunId() };
}
type JourneyEnv = ReturnType<typeof journeyEnv>;

function db(env: JourneyEnv) {
  const headers = { apikey: env.serviceRoleKey, Authorization: `Bearer ${env.serviceRoleKey}` };
  return {
    async subscription(userId: string): Promise<(SubscriptionRow & { stripe_customer_id?: string | null }) | null> {
      const res = await fetch(
        `${env.supabaseUrl}/rest/v1/hermes_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=plan,status,stripe_customer_id,stripe_subscription_id,instance_limit,total_cpu_budget,total_ram_budget,trial_ends_at`,
        { headers },
      );
      if (!res.ok) throw new Error(`[trial-journey] subscription read failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return ((await res.json()) as SubscriptionRow[])[0] ?? null;
    },
    async remove(userId: string): Promise<void> {
      for (const table of ['hermes_trial_usage', 'hermes_subscriptions']) {
        await fetch(`${env.supabaseUrl}/rest/v1/${table}?user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE', headers }).catch(() => undefined);
      }
    },
  };
}

async function waitForState(env: JourneyEnv, userId: string, want: 'trial' | 'pro', timeoutMs = 120_000) {
  let row: Awaited<ReturnType<ReturnType<typeof db>['subscription']>> = null;
  await expect
    .poll(async () => accountState((row = await db(env).subscription(userId))), {
      message: `account should reach "${want}"`,
      timeout: timeoutMs,
      intervals: [2_000, 5_000],
    })
    .toBe(want);
  return row!;
}

/** Pricing → "Start a 7-day free trial" → Stripe Checkout with the test card → back on billing. */
async function startTrialFromPricing(page: Page, name: string): Promise<void> {
  await page.goto('/pricing', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-trial-note'), 'the pricing page offers the card trial (HIVRA_CARD_TRIAL=on)').toBeVisible();
  await page.getByRole('link', { name: /Start a 7-day free trial/ }).click();
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
  await page.locator('#cardNumber').fill(TEST_CARD);
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  await page.locator('#billingName').fill(name);
  const postal = page.locator('#billingPostalCode');
  if (await postal.isVisible().catch(() => false)) await postal.fill('10001');
  await page.getByTestId('hosted-payment-submit-button').click();
  await page.waitForURL(/\/dashboard\/billing\?subscription=success/, { timeout: 90_000 });
}

async function newCustomer(browser: Browser, env: JourneyEnv, label: string) {
  const user = await createAuditUser(env.clerkSecretKey, auditEmail(`trial-${label}-${env.runId}`, 'hermesos.cloud'));
  const context = await establishAuditSession(browser, { baseUrl: env.baseUrl, ticket: await mintSignInTicket(env.clerkSecretKey, user.id) });
  return { user, context };
}

async function teardown(env: JourneyEnv, userId: string): Promise<void> {
  const row = await db(env).subscription(userId).catch(() => null);
  if (row?.stripe_subscription_id) await cancelSubscription(env.stripeKey, row.stripe_subscription_id);
  if (row?.stripe_customer_id) await deleteCustomer(env.stripeKey, row.stripe_customer_id);
  await db(env).remove(userId);
  await deleteAuditUser(env.clerkSecretKey, userId);
}

test.describe('trial to Pro', () => {
  test.skip(!ENABLED, 'TRIAL_JOURNEY=1 is required: this uses Stripe test mode on Canary.');

  test('a new customer trials the entry plan, then becomes Pro when the card is charged; the card gets one trial', async ({ browser }) => {
    const env = journeyEnv();
    const users: string[] = [];
    try {
      const first = await newCustomer(browser, env, 'a');
      users.push(first.user.id);
      const page = await first.context.newPage();
      const started = new Date();
      await test.step('start the trial from the pricing page', () => startTrialFromPricing(page, 'Trial Journey'));

      const trial = await test.step('the account is in the trial, with its small pool', () => waitForState(env, first.user.id, 'trial'));
      expect(trialLengthOk(trial.trial_ends_at!, started), `trial ends in 7 days (${trial.trial_ends_at})`).toBe(true);
      const sub = await getSubscription(env.stripeKey, trial.stripe_subscription_id!);
      expect(sub.status).toBe('trialing');
      expect(sub.metadata.hivra_trial).toBe('card_7d');

      await test.step('the trial ends, the card is charged, and the account becomes full Pro', async () => {
        await endTrialNow(env.stripeKey, sub.id);
        await waitForState(env, first.user.id, 'pro');
        expect((await getSubscription(env.stripeKey, sub.id)).status).toBe('active');
      });
      await first.context.close();

      await test.step('a second account with the same card is charged at once, with no trial', async () => {
        const second = await newCustomer(browser, env, 'b');
        users.push(second.user.id);
        await startTrialFromPricing(await second.context.newPage(), 'Trial Journey Repeat');
        const row = await waitForState(env, second.user.id, 'pro');
        expect((await getSubscription(env.stripeKey, row.stripe_subscription_id!)).status).toBe('active');
        await second.context.close();
      });
    } finally {
      for (const userId of users) await teardown(env, userId);
    }
  });
});
