/**
 * Ensure or repair the standing Canary QA account. Idempotent: creates the
 * Clerk user when it is missing, then resets its Hivra rows to a known state:
 * the Pro plan and its pool, a low-risk signup assessment (so a datacenter CI
 * runner is not asked for a card), and Hivra credit topped up or trimmed to a
 * small fixed balance.
 *
 * Canary only: every entry point re-checks the Clerk key and the Supabase host.
 */
import {
  assertCanaryQaClerkKey,
  assertCanaryQaSupabaseUrl,
  CANARY_QA_LEDGER_ACTOR,
  CANARY_QA_PLAN,
  CANARY_QA_PLAN_SIZE,
  CANARY_QA_SUBSCRIPTION_ID,
} from '../../e2e/canary-qa/config';
import { assertClerkTestAuditEmail } from '../../e2e/first-run-audit/config';

const CLERK_API = 'https://api.clerk.com/v1';

type Fetch = typeof fetch;

export interface EnsureCanaryQaAccountOptions {
  email: string;
  clerkSecretKey: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  creditMicroUsd: number;
  fetchImpl?: Fetch;
  now?: Date;
}

export interface EnsureCanaryQaAccountResult {
  userId: string;
  createdClerkUser: boolean;
  plan: string;
  creditBeforeMicroUsd: number;
  creditAfterMicroUsd: number;
  activeAgents: number;
}

interface ClerkUserPayload {
  id?: string;
  created_at?: number;
}

async function readJson(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new Error(`[canary-qa] ${what} failed: HTTP ${res.status}`);
  return text ? JSON.parse(text) : null;
}

async function ensureClerkUser(
  fetchImpl: Fetch,
  secretKey: string,
  email: string,
): Promise<{ id: string; createdAtMs: number; created: boolean }> {
  const headers = { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
  const found = (await readJson(
    await fetchImpl(`${CLERK_API}/users?email_address=${encodeURIComponent(email)}&limit=2`, { headers }),
    'Clerk user lookup',
  )) as ClerkUserPayload[];
  if (found.length > 1) throw new Error('[canary-qa] more than one Clerk user owns the QA address; resolve it by hand.');
  const existing = found[0];
  if (existing?.id) return { id: existing.id, createdAtMs: existing.created_at ?? 0, created: false };

  const created = (await readJson(
    await fetchImpl(`${CLERK_API}/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email_address: [email],
        skip_password_requirement: true,
        first_name: 'Canary',
        last_name: 'QA',
      }),
    }),
    'Clerk user create',
  )) as ClerkUserPayload;
  if (!created?.id) throw new Error('[canary-qa] Clerk created no user id.');
  return { id: created.id, createdAtMs: created.created_at ?? Date.now(), created: true };
}

export async function ensureCanaryQaAccount(options: EnsureCanaryQaAccountOptions): Promise<EnsureCanaryQaAccountResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = (options.now ?? new Date()).toISOString();
  assertClerkTestAuditEmail(options.email);
  assertCanaryQaClerkKey(options.clerkSecretKey);
  const origin = assertCanaryQaSupabaseUrl(options.supabaseUrl);
  if (!options.serviceRoleKey) throw new Error('[canary-qa] the Canary Supabase service-role key is required.');

  const user = await ensureClerkUser(fetchImpl, options.clerkSecretKey, options.email);
  const userId = encodeURIComponent(user.id);

  const rest = async (path: string, init: RequestInit & { prefer?: string } = {}, what = path) => {
    const { prefer, ...rest } = init;
    return readJson(
      await fetchImpl(`${origin}/rest/v1/${path}`, {
        ...rest,
        headers: {
          apikey: options.serviceRoleKey,
          Authorization: `Bearer ${options.serviceRoleKey}`,
          'Content-Type': 'application/json',
          ...(prefer ? { Prefer: prefer } : {}),
        },
      }),
      what,
    );
  };

  const [subscription] = (await rest(
    'hermes_subscriptions?on_conflict=user_id',
    {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: JSON.stringify({
        user_id: user.id,
        plan: CANARY_QA_PLAN,
        status: 'active',
        stripe_subscription_id: CANARY_QA_SUBSCRIPTION_ID,
        instance_limit: CANARY_QA_PLAN_SIZE.instance_limit,
        total_cpu_budget: CANARY_QA_PLAN_SIZE.total_cpu_budget,
        total_ram_budget: CANARY_QA_PLAN_SIZE.total_ram_budget,
        current_period_start: now,
        current_period_end: null,
        grace_period_ends_at: null,
        trial_ends_at: null,
        updated_at: now,
      }),
    },
    'plan reset',
  )) as Array<{ id: string; plan: string }>;
  if (!subscription?.id) throw new Error('[canary-qa] plan reset returned no row.');

  await rest(
    'pools?on_conflict=user_id,product_surface',
    {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: JSON.stringify({
        user_id: user.id,
        product_surface: 'hermesos',
        subscription_id: subscription.id,
        cpu_budget: CANARY_QA_PLAN_SIZE.total_cpu_budget,
        ram_budget_mb: CANARY_QA_PLAN_SIZE.total_ram_budget,
        agent_slots: CANARY_QA_PLAN_SIZE.instance_limit,
        priority: CANARY_QA_PLAN_SIZE.pool_priority,
        status: 'active',
        updated_at: now,
      }),
    },
    'pool reset',
  );

  await rest(
    'signup_risk_assessments?on_conflict=user_id',
    {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: JSON.stringify({
        user_id: user.id,
        risk_score: 0,
        risk_tier: 'low',
        decision: 'allow',
        raw_signals: { source: 'canary-qa-account', note: 'standing Canary QA account' },
        updated_at: now,
      }),
    },
    'risk reset',
  );

  // Take the product's one-time starter credit first, so a later launch cannot
  // add it on top of the reset balance.
  await rest(
    'rpc/grant_starter_credit',
    {
      method: 'POST',
      body: JSON.stringify({
        p_user_id: user.id,
        p_amount_micro_usd: 2_000_000,
        p_account_created_at: new Date(user.createdAtMs).toISOString(),
        p_now: now,
      }),
    },
    'starter credit',
  );
  await rest(
    'managed_venice_wallet_accounts?on_conflict=user_id',
    { method: 'POST', prefer: 'resolution=ignore-duplicates', body: JSON.stringify({ user_id: user.id }) },
    'credit wallet',
  );
  const [wallet] = (await rest(`managed_venice_wallet_accounts?user_id=eq.${userId}&select=id`)) as Array<{ id: string }>;
  if (!wallet?.id) throw new Error('[canary-qa] credit wallet is missing after create.');

  const entries = (await rest(
    `managed_venice_card_ledger_entries?user_id=eq.${userId}&select=amount_micro_usd`,
  )) as Array<{ amount_micro_usd: number | string }>;
  const creditBeforeMicroUsd = entries.reduce((sum, row) => sum + Number(row.amount_micro_usd), 0);
  const delta = options.creditMicroUsd - creditBeforeMicroUsd;
  if (delta !== 0) {
    await rest(
      'managed_venice_card_ledger_entries',
      {
        method: 'POST',
        body: JSON.stringify({
          account_id: wallet.id,
          user_id: user.id,
          amount_micro_usd: delta,
          source: 'system',
          actor: CANARY_QA_LEDGER_ACTOR,
          reason: 'admin_adjustment',
          reference_id: `canary_qa_reset:${user.id}:${now}`,
          metadata: { note: 'standing Canary QA account credit reset', targetMicroUsd: options.creditMicroUsd },
        }),
      },
      'credit reset',
    );
  }

  const agents = (await rest(
    `hivra_agents?user_id=eq.${userId}&status=neq.deleted&select=id`,
  )) as Array<{ id: string }>;

  return {
    userId: user.id,
    createdClerkUser: user.created,
    plan: subscription.plan,
    creditBeforeMicroUsd,
    creditAfterMicroUsd: options.creditMicroUsd,
    activeAgents: agents.length,
  };
}
