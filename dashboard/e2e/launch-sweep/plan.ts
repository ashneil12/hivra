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

/**
 * The agent's own lifecycle events, with their stored detail, read before
 * teardown deletes the agent (and its host log with it). Kept in the local
 * result file only; failure details can carry host names.
 */
export async function agentEvidence(
  supabaseUrl: string,
  serviceRoleKey: string,
  agentId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, '')}/rest/v1/hivra_agent_events?agent_id=eq.${encodeURIComponent(agentId)}&select=event,detail,created_at&order=created_at.desc&limit=15`,
      { headers: headers(serviceRoleKey) },
    );
    if (!res.ok) return [{ error: `events HTTP ${res.status}` }];
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
  } catch (err) {
    return [{ error: err instanceof Error ? err.message : String(err) }];
  }
}

/**
 * What Canary's own records still hold for this account, read with the
 * service role. The app's list can come back empty for reasons that have
 * nothing to do with deletion (an expired sign-in answers 401), so teardown
 * never trusts an empty list alone before deleting the account.
 */
export async function agentsStillOnRecord(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<Array<{ id: string; status: string; vmid: number | null }> | null> {
  try {
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, '')}/rest/v1/hivra_agents?user_id=eq.${encodeURIComponent(userId)}&status=neq.deleted&select=id,status,vmid`,
      { headers: headers(serviceRoleKey) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? (rows as Array<{ id: string; status: string; vmid: number | null }>) : null;
  } catch {
    return null;
  }
}
