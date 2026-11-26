/**
 * The standing Canary QA account: one passwordless +clerk_test user on the
 * Canary Clerk development instance that any person or agent can sign into
 * with Clerk's fixed test code. Its address lives only in CANARY_QA_EMAIL and
 * in private notes, never in this public repository: the code is public, so
 * the address is the credential.
 *
 * These guards keep every write on Canary. They are pure so they can be unit
 * tested without network access.
 */
import { createHash } from 'node:crypto';

import { assertClerkTestAuditEmail, assertNotProduction } from '../first-run-audit/config';

export const CANARY_QA_EMAIL_ENV = 'CANARY_QA_EMAIL';
export const CANARY_QA_PLAN = 'operator';
/** Pro ("operator") as src/lib/subscription/plans.ts and agent-slots.ts define it. */
export const CANARY_QA_PLAN_SIZE = Object.freeze({
  instance_limit: 3,
  total_cpu_budget: 2,
  total_ram_budget: 4096,
  pool_priority: 1,
});
/** manual_ ids are never reset by the subscription-state reconciler. */
export const CANARY_QA_SUBSCRIPTION_ID = 'manual_operator_canary_qa_account';
export const CANARY_QA_DEFAULT_CREDIT_USD = 2;
export const CANARY_QA_MAX_CREDIT_USD = 5;
/** Ledger actor on every credit reset, so the resets are easy to find. */
export const CANARY_QA_LEDGER_ACTOR = 'canary_qa_account';

/**
 * SHA-256 of the Canary Supabase hostname. Hashed so the project ref stays out
 * of the public tree while any other project (production included) is refused.
 */
export const CANARY_SUPABASE_HOST_SHA256 = '26724a739d6c5e448cb300d534c4071ee86aecf81463ff55f3238ff038ef3735';

export function readCanaryQaEmail(env: Record<string, string | undefined> = process.env): string {
  const email = env[CANARY_QA_EMAIL_ENV]?.trim().toLowerCase();
  if (!email) {
    throw new Error(`[canary-qa] ${CANARY_QA_EMAIL_ENV} is not set. The address is kept in private notes, not in the repository.`);
  }
  assertClerkTestAuditEmail(email);
  return email;
}

export function assertCanaryQaClerkKey(secretKey: string | null | undefined): asserts secretKey is string {
  if (secretKey?.startsWith('sk_live_')) {
    throw new Error('[canary-qa] refusing a live Clerk secret key (sk_live_…). The QA account exists only on the Canary Clerk development instance.');
  }
  if (!secretKey?.startsWith('sk_test_')) {
    throw new Error('[canary-qa] CLERK_SECRET_KEY must be the Canary Clerk development key (sk_test_…).');
  }
}

export function assertCanaryQaSupabaseUrl(
  url: string | null | undefined,
  expectedHostSha256: string = CANARY_SUPABASE_HOST_SHA256,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url ?? '');
  } catch {
    throw new Error('[canary-qa] the Supabase URL is missing or invalid.');
  }
  const host = parsed.hostname.toLowerCase();
  const digest = createHash('sha256').update(host).digest('hex');
  if (parsed.protocol !== 'https:' || digest !== expectedHostSha256) {
    throw new Error(`[canary-qa] refusing Supabase host "${host}": only the Canary project is allowed.`);
  }
  return parsed.origin;
}

export function assertCanaryQaBaseUrl(baseUrl: string): string {
  assertNotProduction(baseUrl);
  return baseUrl.replace(/\/$/, '');
}

/** Target credit in micro-USD: default $2, never above $5. */
export function canaryQaCreditMicroUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CANARY_QA_CREDIT_USD?.trim();
  let usd = CANARY_QA_DEFAULT_CREDIT_USD;
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`[canary-qa] CANARY_QA_CREDIT_USD must be a number from 0 to ${CANARY_QA_MAX_CREDIT_USD}.`);
    }
    usd = parsed;
  }
  if (usd > CANARY_QA_MAX_CREDIT_USD) {
    throw new Error(`[canary-qa] CANARY_QA_CREDIT_USD is capped at $${CANARY_QA_MAX_CREDIT_USD}.`);
  }
  return Math.round(usd * 1_000_000);
}
