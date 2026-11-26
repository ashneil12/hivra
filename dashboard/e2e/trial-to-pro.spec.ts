/**
 * Stripe test-mode trial-to-Pro coverage for two dedicated, standing Canary
 * billing fixtures. Neither fixture may have existing billing or computers.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { assertCanaryQaSupabaseUrl, readCanaryQaEmail } from './canary-qa/config';
import { newRunId } from './first-run-audit/config';
import { assertUnusedRunId, listHivraAgents, listInstances } from './first-run-audit/instances';
import { establishAuditSession } from './first-run-audit/session';
import { proveChat } from './launch-sweep/chat';
import { launchFromTile, openFromLaunch, waitForReady } from './launch-sweep/journey';
import { SWEEP_TARGETS, type SweepTarget } from './launch-sweep/targets';
import { cleanTrialCustomers, removeTrialAgent, trialDb, type TrialCustomer } from './trial-to-pro/cleanup';
import { accountState, repeatTrialRejected, trialLengthOk } from './trial-to-pro/state';
import { amountPaidCents, assertTestKey, endTrialNow, getSubscription, listSubscriptions, readRunCheckout } from './trial-to-pro/stripe';

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
async function useReferenceAgent(customer: TrialCustomer, env: JourneyEnv, target: SweepTarget): Promise<void> {
  const { context, page } = customer.session;
  const runId = newRunId();
  console.log(`[trial-journey] resource run ${runId}`);
  await assertUnusedRunId(context.request, env.baseUrl, runId);
  const chat = { composerTimeoutMs: 6 * MINUTE, replyTimeoutMs: 6 * MINUTE };
  const agentId = await test.step(`launch ${target.tile} from Launch`, async () => {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await launchFromTile(page, target, runId, () => { customer.resourceRunId = runId; });
    const outcome = await waitForReady(page, context.request, env.baseUrl, target, 25 * MINUTE, runId);
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
  await test.step('it is deleted', () => removeTrialAgent(customer, env.baseUrl));
}

function journeyEnv() {
  const baseUrl = (process.env.TRIAL_JOURNEY_BASE_URL || process.env.E2E_BASE_URL || 'https://canary.hermesos.cloud').replace(/\/$/, '');
  if (!process.env.TRIAL_JOURNEY_FIRST_EMAIL?.trim() || !process.env.TRIAL_JOURNEY_REPEAT_EMAIL?.trim()) {
    throw new Error('[trial-journey] TRIAL_JOURNEY_FIRST_EMAIL and TRIAL_JOURNEY_REPEAT_EMAIL are both required.');
  }
  const firstEmail = readCanaryQaEmail({ CANARY_QA_EMAIL: process.env.TRIAL_JOURNEY_FIRST_EMAIL });
  const repeatEmail = readCanaryQaEmail({ CANARY_QA_EMAIL: process.env.TRIAL_JOURNEY_REPEAT_EMAIL });
  if (firstEmail === repeatEmail) throw new Error('The trial and repeat fixtures must be distinct.');
  if (process.env.CANARY_QA_EMAIL?.trim().toLowerCase() === firstEmail ||
      process.env.CANARY_QA_EMAIL?.trim().toLowerCase() === repeatEmail) {
    throw new Error('The shared QA account is not a dedicated billing fixture.');
  }
  const stripeKey = process.env.TRIAL_JOURNEY_STRIPE_SECRET_KEY?.trim() ?? '';
  assertTestKey(stripeKey);
  const supabaseUrl = assertCanaryQaSupabaseUrl(process.env.LAUNCH_SWEEP_SUPABASE_URL?.trim());
  const serviceRoleKey = process.env.LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceRoleKey) throw new Error('[trial-journey] LAUNCH_SWEEP_SUPABASE_URL and LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY are required.');
  return { baseUrl, firstEmail, repeatEmail, stripeKey, supabaseUrl, serviceRoleKey };
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
async function checkoutFromPricing(env: JourneyEnv, name: string, customer: TrialCustomer) {
  const { page, userId } = customer.session;
  await page.goto('/pricing', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-trial-note'), 'the pricing page offers the card trial (HIVRA_CARD_TRIAL=on)').toBeVisible();
  customer.checkoutAttempted = true;
  await page.getByRole('link', { name: /Start a 7-day free trial/ }).click();
  await page.waitForURL((url) => url.origin === 'https://checkout.stripe.com', { timeout: 60_000 })
    .catch(() => { throw new Error('Stripe Checkout did not open'); });
  const id = new URL(page.url()).pathname.match(/(?:^|\/)(cs_test_[A-Za-z0-9]+)\/?$/)?.[1];
  if (!id) throw new Error('Stripe test checkout could not be identified');
  await readRunCheckout(env.stripeKey, id, userId, customer.startedAt);
  customer.checkoutIds.push(id);
  await page.locator('#cardNumber').fill(TEST_CARD);
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  await page.locator('#billingName').fill(name);
  const postal = page.locator('#billingPostalCode');
  if (await postal.isVisible().catch(() => false)) await postal.fill('10001');
  await page.getByTestId('hosted-payment-submit-button').click();
  await page.waitForURL((url) => url.origin === env.baseUrl && url.pathname === '/dashboard/billing' &&
    url.searchParams.get('subscription') === 'success', { timeout: 90_000 });
  return readRunCheckout(env.stripeKey, id, userId, customer.startedAt);
}

async function openCustomer(browser: Browser, env: JourneyEnv, email: string, customers: TrialCustomer[]) {
  const session = await establishAuditSession(browser, { baseUrl: env.baseUrl, email });
  const customer: TrialCustomer = { session, startedAt: Date.now(), checkoutIds: [] };
  customers.push(customer);
  const db = trialDb(env);
  const [subscription, usage, agents, instances] = await Promise.all([
    db.subscription(session.userId),
    db.trialUsage(session.userId),
    listHivraAgents(session.context.request, env.baseUrl, true),
    listInstances(session.context.request, env.baseUrl, true),
  ]);
  if (subscription || usage.length || agents.length || instances.length) {
    throw new Error('Trial fixtures must have no existing subscription, trial history, or computers.');
  }
  return customer;
}

test.describe('trial to Pro', () => {
  test.skip(!ENABLED, 'TRIAL_JOURNEY=1 is required: this uses Stripe test mode on Canary.');

  test('a standing billing fixture trials the entry plan, becomes Pro when the card is charged, and uses an agent; the card gets one trial', async ({ browser }) => {
    test.setTimeout(75 * MINUTE);
    const env = journeyEnv();
    const target = referenceTarget();
    const customers: TrialCustomer[] = [];
    try {
      const first = await openCustomer(browser, env, env.firstEmail, customers);
      const second = await openCustomer(browser, env, env.repeatEmail, customers);
      if (first.session.userId === second.session.userId) throw new Error('Trial fixtures resolved to the same standing account');

      const started = new Date();
      const checkout = await test.step('start the trial from the pricing page', () => checkoutFromPricing(env, 'Trial Journey', first));

      const trial = await test.step('the account is in the trial, with its small pool', () => waitForState(env, first.session.userId, 'trial'));
      expect(trialLengthOk(trial.trial_ends_at!, started), `trial ends in 7 days (${trial.trial_ends_at})`).toBe(true);
      expect(trial.stripe_subscription_id === checkout.subscription && trial.stripe_customer_id === checkout.customer,
        'The trial matches this run’s Stripe Checkout').toBe(true);
      const sub = await getSubscription(env.stripeKey, trial.stripe_subscription_id!);
      expect(sub.status).toBe('trialing');
      expect(sub.metadata.hivra_trial).toBe('card_7d');

      await test.step('the trial ends, the card is charged, and the account becomes full Pro', async () => {
        await endTrialNow(env.stripeKey, sub.id);
        await waitForState(env, first.session.userId, 'pro');
        expect((await getSubscription(env.stripeKey, sub.id)).status).toBe('active');
      });

      if (target) await useReferenceAgent(first, env, target);

      await test.step('a second account with the same card gets no trial and is not charged', async () => {
        await checkoutFromPricing(env, 'Trial Journey Repeat', second);
        await waitForRejectedTrial(env, second.session.userId);

        await test.step('its retry is paid checkout, charged at once, and the account becomes full Pro', async () => {
          await checkoutFromPricing(env, 'Trial Journey Repeat', second);
          const row = await waitForState(env, second.session.userId, 'pro');
          const paid = await getSubscription(env.stripeKey, row.stripe_subscription_id!);
          expect(paid.status).toBe('active');
          expect(paid.trial_end, 'the retry has no trial').toBeNull();
          expect(paid.metadata.hivra_trial).toBeUndefined();
          expect(await amountPaidCents(env.stripeKey, row.stripe_customer_id!), 'the retry is charged').toBeGreaterThan(0);
        });
      });
    } finally {
      await test.step('verify cleanup without changing the standing identities', () => cleanTrialCustomers(env, customers));
    }
  });
});
