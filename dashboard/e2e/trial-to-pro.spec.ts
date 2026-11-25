/**
 * CUSTOMER PATH: a new customer starts the 7-day card trial from the pricing
 * page, pays nothing at Stripe Checkout with a test card, gets the trial's small
 * pool, and becomes a full Pro account when the trial ends and the card is
 * charged. It then launches one reference agent (CUSTOMER_PATH_AGENT, default
 * claude-code), gets a real reply, sleeps and wakes it, gets another reply and
 * deletes it. A second account with the same card gets no second trial: that
 * trial is canceled without a charge, and the account's retry is paid at once.
 *
 * This is the one full customer path run on every Canary release. Per-agent
 * checks are separate and cheap, so its cost stays flat as the catalog grows.
 *
 * Canary only, Stripe test mode only, and opt-in: TRIAL_JOURNEY=1. Needs the
 * card trial switched on (HIVRA_CARD_TRIAL=on) and its migration on Canary.
 * Teardown must confirm cleanup of each disposable account's resources.
 *
 *   TRIAL_JOURNEY=1 CLERK_SECRET_KEY=sk_test_… LAUNCH_SWEEP_SUPABASE_URL=… \
 *     LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY=… TRIAL_JOURNEY_STRIPE_SECRET_KEY=sk_test_… \
 *     npm run test:trial-journey
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { assertNotProduction, auditEmail, AUDIT_EMAIL_DOMAIN, newRunId } from './first-run-audit/config';
import { createAuditUser } from './first-run-audit/clerk-admin';
import { establishAuditSession } from './first-run-audit/session';
import { proveChat } from './launch-sweep/chat';
import { launchFromTile, openFromLaunch, waitForReady } from './launch-sweep/journey';
import { SWEEP_TARGETS, type SweepTarget } from './launch-sweep/targets';
import { cleanTrialCustomers, removeTrialAgents, trialDb, type TrialCustomer } from './trial-to-pro/cleanup';
import { accountState, repeatTrialRejected, trialLengthOk } from './trial-to-pro/state';
import { amountPaidCents, assertTestKey, endTrialNow, getSubscription, listSubscriptions } from './trial-to-pro/stripe';

const ENABLED = process.env.TRIAL_JOURNEY === '1';
const TEST_CARD = process.env.TRIAL_JOURNEY_CARD?.trim() || '4242424242424242';
// The one reference agent the paid account launches, uses, sleeps, wakes and
// deletes. CUSTOMER_PATH_AGENT=none skips that part (trial and billing only).
const REFERENCE_AGENT = process.env.CUSTOMER_PATH_AGENT?.trim() || 'claude-code';
const MINUTE = 60_000;

function referenceTarget(): SweepTarget | null {
  if (REFERENCE_AGENT === 'none') return null;
  const target = SWEEP_TARGETS.find((row) => row.profileId === REFERENCE_AGENT);
  if (!target || target.kind !== 'agent') throw new Error(`[trial-journey] CUSTOMER_PATH_AGENT=${REFERENCE_AGENT} is not an agent in e2e/launch-sweep/targets.ts.`);
  return target;
}

/** A same-origin call from the signed-in page, as the app's own buttons make it. */
async function postFromPage(page: Page, path: string, body: unknown): Promise<{ status: number; text: string }> {
  return page.evaluate(async ([url, payload]) => {
    const res = await fetch(url as string, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: res.status, text: (await res.text()).slice(0, 300) };
  }, [path, body] as const);
}

/** Launch the reference agent from Launch, get a real reply, sleep it, wake it, get another reply, delete it. */
async function useReferenceAgent(page: Page, context: BrowserContext, env: JourneyEnv, target: SweepTarget): Promise<void> {
  const chat = { composerTimeoutMs: 6 * MINUTE, replyTimeoutMs: 6 * MINUTE };
  const agentId = await test.step(`launch ${target.tile} from Launch`, async () => {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await launchFromTile(page, target);
    const outcome = await waitForReady(page, context.request, env.baseUrl, target, 25 * MINUTE);
    expect(outcome.ready, `${target.tile} said it was ready`).toBe(true);
    expect(outcome.agentId).toBeTruthy();
    return outcome.agentId!;
  });
  await test.step('it answers', async () => {
    await openFromLaunch(page);
    await proveChat(page, target, chat);
  });
  await test.step('it sleeps and wakes, then answers again', async () => {
    const slept = await postFromPage(page, `/api/hivra/agents/${agentId}/sleep`, { tier: 'nap' });
    expect(slept.status, `sleep: ${slept.text}`).toBeLessThan(300);
    const woke = await postFromPage(page, `/api/hivra/agents/${agentId}/wake`, {});
    expect(woke.status, `wake: ${woke.text}`).toBeLessThan(300);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await proveChat(page, target, chat);
  });
  await test.step('it is deleted', () => removeTrialAgents(context, env.baseUrl));
}

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

async function waitForState(env: JourneyEnv, userId: string, want: 'trial' | 'pro', timeoutMs = 120_000) {
  const db = trialDb(env);
  let row: Awaited<ReturnType<typeof db.subscription>> = null;
  await expect
    .poll(async () => accountState((row = await db.subscription(userId))), {
      message: `account should reach "${want}"`,
      timeout: timeoutMs,
      intervals: [2_000, 5_000],
    })
    .toBe(want);
  return row!;
}

/** The repeat card's trial is canceled by the webhook, nothing is charged, and the account is neither in a trial nor Pro. */
async function waitForRejectedTrial(env: JourneyEnv, userId: string, timeoutMs = 120_000): Promise<void> {
  const db = trialDb(env);
  await expect
    .poll(async () => {
      const row = await db.subscription(userId);
      if (!row?.stripe_customer_id) return false;
      const subs = await listSubscriptions(env.stripeKey, row.stripe_customer_id);
      return repeatTrialRejected(subs, await amountPaidCents(env.stripeKey, row.stripe_customer_id));
    }, { message: 'the repeat card trial should be canceled without a charge', timeout: timeoutMs, intervals: [2_000, 5_000] })
    .toBe(true);
  const state = accountState(await db.subscription(userId));
  expect(['trial', 'pro'], `a rejected trial grants no plan (state ${state})`).not.toContain(state);
}

/** Pricing → "Start a 7-day free trial" → Stripe Checkout with the test card → back on billing. Ineligible accounts get paid checkout. */
async function checkoutFromPricing(page: Page, name: string, customer: TrialCustomer): Promise<void> {
  await page.goto('/pricing', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-trial-note'), 'the pricing page offers the card trial (HIVRA_CARD_TRIAL=on)').toBeVisible();
  customer.checkoutAttempted = true;
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

async function newCustomer(browser: Browser, env: JourneyEnv, label: string, customers: TrialCustomer[]) {
  const email = auditEmail(`trial-${label}-${env.runId}`, AUDIT_EMAIL_DOMAIN);
  const user = await createAuditUser(env.clerkSecretKey, email);
  const customer: TrialCustomer = { userId: user.id };
  customers.push(customer);
  const context = await establishAuditSession(browser, {
    baseUrl: env.baseUrl,
    email,
    onContext: (created) => { customer.context = created; },
  });
  customer.signedIn = true;
  return { customer, context };
}

test.describe('trial to Pro', () => {
  test.skip(!ENABLED, 'TRIAL_JOURNEY=1 is required: this uses Stripe test mode on Canary.');

  test('a new customer trials the entry plan, becomes Pro when the card is charged, and uses an agent; the card gets one trial', async ({ browser }) => {
    test.setTimeout(75 * MINUTE);
    const env = journeyEnv();
    const target = referenceTarget();
    const customers: TrialCustomer[] = [];
    try {
      const first = await newCustomer(browser, env, 'a', customers);
      const page = await first.context.newPage();
      const started = new Date();
      await test.step('start the trial from the pricing page', () => checkoutFromPricing(page, 'Trial Journey', first.customer));

      const trial = await test.step('the account is in the trial, with its small pool', () => waitForState(env, first.customer.userId, 'trial'));
      expect(trialLengthOk(trial.trial_ends_at!, started), `trial ends in 7 days (${trial.trial_ends_at})`).toBe(true);
      const sub = await getSubscription(env.stripeKey, trial.stripe_subscription_id!);
      expect(sub.status).toBe('trialing');
      expect(sub.metadata.hivra_trial).toBe('card_7d');

      await test.step('the trial ends, the card is charged, and the account becomes full Pro', async () => {
        await endTrialNow(env.stripeKey, sub.id);
        await waitForState(env, first.customer.userId, 'pro');
        expect((await getSubscription(env.stripeKey, sub.id)).status).toBe('active');
      });

      if (target) await useReferenceAgent(page, first.context, env, target);

      await test.step('a second account with the same card gets no trial and is not charged', async () => {
        const second = await newCustomer(browser, env, 'b', customers);
        const secondPage = await second.context.newPage();
        await checkoutFromPricing(secondPage, 'Trial Journey Repeat', second.customer);
        await waitForRejectedTrial(env, second.customer.userId);

        await test.step('its retry is paid checkout, charged at once, and the account becomes full Pro', async () => {
          await checkoutFromPricing(secondPage, 'Trial Journey Repeat', second.customer);
          const row = await waitForState(env, second.customer.userId, 'pro');
          const paid = await getSubscription(env.stripeKey, row.stripe_subscription_id!);
          expect(paid.status).toBe('active');
          expect(paid.trial_end, 'the retry has no trial').toBeNull();
          expect(paid.metadata.hivra_trial).toBeUndefined();
          expect(await amountPaidCents(env.stripeKey, row.stripe_customer_id!), 'the retry is charged').toBeGreaterThan(0);
        });
      });
    } finally {
      await test.step('verify cleanup of disposable accounts', () => cleanTrialCustomers(env, customers));
    }
  });
});
