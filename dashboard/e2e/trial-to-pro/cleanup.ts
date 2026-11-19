import type { BrowserContext } from '@playwright/test';

import { deleteAuditUser } from '../first-run-audit/clerk-admin';
import { destroyAllHivraAgents } from '../first-run-audit/instances';
import type { SubscriptionRow } from './state';
import { removeOwnedStripeBilling } from './stripe';

interface TrialDatabaseConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export interface TrialCustomer {
  userId: string;
  context?: BrowserContext;
  signedIn?: boolean;
  checkoutAttempted?: boolean;
}

export function trialDb({ supabaseUrl, serviceRoleKey }: TrialDatabaseConfig) {
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  type Table = 'hermes_trial_usage' | 'hermes_subscriptions';

  async function request(table: Table, userId: string, method: 'GET' | 'DELETE', query = '') {
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?user_id=eq.${encodeURIComponent(userId)}${query}`, {
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

  return {
    async subscription(userId: string): Promise<(SubscriptionRow & { stripe_customer_id?: string | null }) | null> {
      const result = await rows('hermes_subscriptions', userId,
        '&select=user_id,plan,status,stripe_customer_id,stripe_subscription_id,instance_limit,total_cpu_budget,total_ram_budget,trial_ends_at&limit=2');
      if (!result.length) return null;
      const [row] = result as (SubscriptionRow & { user_id: string; stripe_customer_id?: string | null })[];
      if (result.length !== 1 || row?.user_id !== userId) throw new Error('Subscription ownership not confirmed');
      return row;
    },
    async remove(userId: string): Promise<void> {
      for (const table of ['hermes_trial_usage', 'hermes_subscriptions'] as const) {
        await request(table, userId, 'DELETE');
        if ((await rows(table, userId, '&select=user_id&limit=1')).length) {
          throw new Error(`${table} still contains rows for this account`);
        }
      }
    },
  };
}

export async function removeTrialAgents(context: BrowserContext, baseUrl: string): Promise<void> {
  const { survived } = await destroyAllHivraAgents(context.request, baseUrl, 30, 15_000, { verifyDisappearance: true });
  if (survived.length) throw new Error('Agents still listed after cleanup');
}

export async function cleanTrialCustomers(
  env: TrialDatabaseConfig & { baseUrl: string; clerkSecretKey: string; stripeKey: string },
  customers: readonly TrialCustomer[],
): Promise<void> {
  const db = trialDb(env);
  const failures: string[] = [];
  for (const { userId, context, signedIn, checkoutAttempted } of customers) {
    let stage = 'agents';
    try {
      if (signedIn) {
        if (!context) throw new Error('Authenticated context is missing');
        await removeTrialAgents(context, env.baseUrl);
      }
      stage = 'billing lookup';
      const row = await db.subscription(userId);
      if (checkoutAttempted && !row?.stripe_customer_id) throw new Error('Checkout was attempted but the Stripe customer is unknown');
      stage = 'Stripe';
      await removeOwnedStripeBilling(env.stripeKey, userId, row?.stripe_customer_id, row?.stripe_subscription_id);
      stage = 'database';
      await db.remove(userId);
      stage = 'Clerk';
      await deleteAuditUser(env.clerkSecretKey, userId, { verifyDeletion: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      failures.push(`${userId} (${stage}): ${detail}`);
    } finally {
      await context?.close().catch(() => { failures.push(`${userId}: Browser context did not close`); });
    }
  }
  if (failures.length) throw new Error(`[trial-journey] Incomplete cleanup: ${failures.join('; ')}`);
}
