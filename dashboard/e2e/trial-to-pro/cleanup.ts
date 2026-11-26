import { destroyRunResources } from '../first-run-audit/instances';
import { establishAuditSession, verifyAuditSession } from '../first-run-audit/session';
import type { SubscriptionRow } from './state';
import { listSubscriptions, readRunCheckout, removeOwnedStripeBilling } from './stripe';

interface TrialDatabaseConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export interface TrialCustomer {
  session: Awaited<ReturnType<typeof establishAuditSession>>;
  startedAt: number;
  checkoutIds: string[];
  checkoutAttempted?: boolean;
  resourceRunId?: string;
}

type TrialUsageRow = { id: string; created_at: string; stripe_subscription_id: string | null };

export function trialDb({ supabaseUrl, serviceRoleKey }: TrialDatabaseConfig) {
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  type Table = 'hermes_trial_usage' | 'hermes_subscriptions';

  async function request(table: Table, userId: string, method: 'GET' | 'DELETE', query: string) {
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?user_id=eq.${encodeURIComponent(userId)}&${query}`, {
      method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    }).catch(() => { throw new Error(`${table} ${method}: request failed`); });
    if (!res.ok) throw new Error(`${table} ${method}: HTTP ${res.status}`);
    return res;
  }

  async function rows(table: Table, userId: string, query: string): Promise<unknown[]> {
    const res = await request(table, userId, 'GET', query);
    const body = await res.json().catch(() => null);
    if (!Array.isArray(body)) throw new Error(`${table} read not confirmed`);
    return body;
  }

  async function subscription(userId: string): Promise<(SubscriptionRow & { stripe_customer_id?: string | null }) | null> {
    const result = await rows('hermes_subscriptions', userId,
      'select=user_id,plan,status,stripe_customer_id,stripe_subscription_id,instance_limit,total_cpu_budget,total_ram_budget,trial_ends_at&limit=2');
    if (!result.length) return null;
    const [row] = result as (SubscriptionRow & { user_id: string; stripe_customer_id?: string | null })[];
    if (result.length !== 1 || row?.user_id !== userId) throw new Error('Subscription ownership not confirmed');
    return row;
  }

  async function trialUsage(userId: string): Promise<TrialUsageRow[]> {
    return await rows('hermes_trial_usage', userId, 'select=id,created_at,stripe_subscription_id') as TrialUsageRow[];
  }

  return {
    subscription,
    trialUsage,
    async removeRunRows(userId: string, customerId: string, subscriptionIds: ReadonlySet<string>, usage: TrialUsageRow[]) {
      const row = await subscription(userId);
      if (row) {
        if (row.stripe_customer_id !== customerId || (row.stripe_subscription_id && !subscriptionIds.has(row.stripe_subscription_id))) {
          throw new Error('Subscription changed during cleanup');
        }
        const stripeSub = row.stripe_subscription_id
          ? `eq.${encodeURIComponent(row.stripe_subscription_id)}` : 'is.null';
        await request('hermes_subscriptions', userId, 'DELETE',
          `stripe_customer_id=eq.${encodeURIComponent(customerId)}&stripe_subscription_id=${stripeSub}`);
      }
      for (const { id } of usage) {
        await request('hermes_trial_usage', userId, 'DELETE', `id=eq.${encodeURIComponent(id)}`);
      }
      if (await subscription(userId) || (await trialUsage(userId)).length) {
        throw new Error('Trial fixture did not return to its original empty billing state');
      }
    },
  };
}

export async function cleanTrialBilling(
  env: TrialDatabaseConfig & { stripeKey: string },
  userId: string,
  checkoutIds: readonly string[],
  startedAt: number,
): Promise<void> {
  if (!checkoutIds.length) throw new Error('No verified run checkout was captured; refusing billing cleanup');
  const checkouts = await Promise.all(checkoutIds.map((id) => readRunCheckout(env.stripeKey, id, userId, startedAt)));
  const [{ customer }] = checkouts;
  if (checkouts.some((checkout) => checkout.customer !== customer)) throw new Error('Checkout customer changed');

  const db = trialDb(env);
  const subscriptionIds = new Set(checkouts.flatMap(({ subscription }) => subscription ? [subscription] : []));
  const [row, usage, subscriptions] = await Promise.all([
    db.subscription(userId), db.trialUsage(userId), listSubscriptions(env.stripeKey, customer),
  ]);
  if (subscriptions.some(({ id }) => !subscriptionIds.has(id)) ||
      (row && (row.stripe_customer_id !== customer || (row.stripe_subscription_id && !subscriptionIds.has(row.stripe_subscription_id))))) {
    throw new Error('Unrelated Stripe billing detected; refusing cleanup');
  }
  if (usage.length > 1 || usage.some(({ id, created_at, stripe_subscription_id }) =>
      !id || !(Date.parse(created_at) >= startedAt) || !checkouts.some((checkout) => checkout.trial && checkout.subscription &&
        (stripe_subscription_id === null || checkout.subscription === stripe_subscription_id)))) {
    throw new Error('Unrelated trial history detected; refusing cleanup');
  }

  const active = subscriptions.filter(({ status }) => status !== 'canceled');
  if (active.length > 1) throw new Error('Multiple active Stripe subscriptions; refusing cleanup');
  await removeOwnedStripeBilling(env.stripeKey, userId, customer, active[0]?.id);
  await db.removeRunRows(userId, customer, subscriptionIds, usage);
}

export async function removeTrialAgent(customer: TrialCustomer, baseUrl: string): Promise<void> {
  if (!customer.resourceRunId) return;
  const { context, page, userId } = customer.session;
  await verifyAuditSession(page, baseUrl, userId);
  const { survived } = await destroyRunResources(context.request, baseUrl, customer.resourceRunId);
  if (survived.length) throw new Error(`Trial computer survived cleanup; inspect run ${customer.resourceRunId}.`);
  customer.resourceRunId = undefined;
}

export async function cleanTrialCustomers(
  env: TrialDatabaseConfig & { baseUrl: string; stripeKey: string },
  customers: readonly TrialCustomer[],
): Promise<void> {
  const failures: string[] = [];
  for (const [index, customer] of customers.entries()) {
    const label = index === 0 ? 'first fixture' : 'repeat fixture';
    try {
      await removeTrialAgent(customer, env.baseUrl);
      if (customer.checkoutAttempted) {
        await cleanTrialBilling(env, customer.session.userId, customer.checkoutIds, customer.startedAt);
      }
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await customer.session.context.close().catch(() => { failures.push(`${label}: Browser context did not close`); });
    }
  }
  if (failures.length) throw new Error(`[trial-journey] Incomplete cleanup: ${failures.join('; ')}`);
}
