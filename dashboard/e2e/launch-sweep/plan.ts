/**
 * The one step that isn't the customer path: the throwaway account gets the
 * Pro plan by writing its subscription row, instead of paying through Stripe.
 * Everything after that (the plan check on Launch, the $2 starter credit, the
 * launch itself) is the product's own code path.
 *
 * Canary only. Teardown deletes this exact user's row.
 */

/** Pro ("operator") as src/lib/subscription/plans.ts defines it. */
const PLAN_SIZES: Record<string, { instance_limit: number; total_cpu_budget: number; total_ram_budget: number }> = {
  operator: { instance_limit: 3, total_cpu_budget: 2, total_ram_budget: 4096 },
  fleet: { instance_limit: 5, total_cpu_budget: 4, total_ram_budget: 8192 },
};

function headers(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

export async function grantSweepPlan(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  plan = process.env.LAUNCH_SWEEP_PLAN?.trim() || 'operator',
): Promise<void> {
  const size = PLAN_SIZES[plan];
  if (!size) throw new Error(`[launch-sweep] unknown LAUNCH_SWEEP_PLAN "${plan}" (operator or fleet)`);
  const now = new Date().toISOString();
  const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/hermes_subscriptions?on_conflict=user_id`, {
    method: 'POST',
    headers: { ...headers(serviceRoleKey), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      user_id: userId,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      plan,
      status: 'active',
      ...size,
      current_period_start: now,
      current_period_end: null,
      grace_period_ends_at: null,
      updated_at: now,
    }),
  });
  if (!res.ok) {
    throw new Error(`[launch-sweep] plan setup failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

export async function removeSweepPlan(supabaseUrl: string, serviceRoleKey: string, userId: string): Promise<void> {
  await fetch(
    `${supabaseUrl.replace(/\/$/, '')}/rest/v1/hermes_subscriptions?user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: headers(serviceRoleKey) },
  ).catch(() => undefined);
}
