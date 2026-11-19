/**
 * What the trial-to-Pro journey expects the account's subscription row to say
 * at each step, from the card trial (src/lib/billing/card-trial.ts) and Pro
 * ("operator") in src/lib/subscription/plans.ts.
 */
export const TRIAL_POOL = { instance_limit: 1, total_cpu_budget: 1, total_ram_budget: 2048 } as const;
export const PRO_POOL = { instance_limit: 3, total_cpu_budget: 2, total_ram_budget: 4096 } as const;

export interface SubscriptionRow {
  plan?: string | null;
  status?: string | null;
  stripe_subscription_id?: string | null;
  instance_limit?: number | null;
  total_cpu_budget?: number | null;
  total_ram_budget?: number | null;
  trial_ends_at?: string | null;
}

export type AccountState = 'none' | 'trial' | 'pro' | 'other';

function hasPool(row: SubscriptionRow, pool: typeof TRIAL_POOL | typeof PRO_POOL): boolean {
  return (
    row.instance_limit === pool.instance_limit &&
    row.total_cpu_budget === pool.total_cpu_budget &&
    row.total_ram_budget === pool.total_ram_budget
  );
}

/** Trial: active Pro row with the trial's small pool and an end date. Pro: the full pool, no end date. */
export function accountState(row: SubscriptionRow | null | undefined): AccountState {
  if (!row) return 'none';
  if (row.plan !== 'operator' || row.status !== 'active' || !row.stripe_subscription_id) return 'other';
  if (row.trial_ends_at && hasPool(row, TRIAL_POOL)) return 'trial';
  if (!row.trial_ends_at && hasPool(row, PRO_POOL)) return 'pro';
  return 'other';
}

/** The trial should end about 7 days after it started. */
export function trialLengthOk(trialEndsAt: string, startedAt: Date): boolean {
  const days = (new Date(trialEndsAt).getTime() - startedAt.getTime()) / 86_400_000;
  return days > 6.9 && days < 7.1;
}
