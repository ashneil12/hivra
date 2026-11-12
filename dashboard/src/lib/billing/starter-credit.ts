// Starter credit: a one-time grant of Hivra credits (the managed Venice card
// wallet) for an account with an active paid plan, so its first agent launch on
// Hivra credits does not stop at "Add credit". Free accounts never get it.
//
// Hooked in best-effort at the launch "prepare" step and at managed proxy key
// mint. It never throws and never blocks a launch. The SQL function
// grant_starter_credit makes it idempotent: one grant per user, ever.

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

const SOURCE = "starter-credit";
const MICRO_USD_PER_USD = 1_000_000;
const DEFAULT_STARTER_CREDIT_USD = 2;
const MAX_STARTER_CREDIT_USD = 10;

/** HIVRA_STARTER_CREDIT_USD in micro-USD: default $2, "0" turns it off, invalid -> default, capped at $10. */
export function starterCreditMicroUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HIVRA_STARTER_CREDIT_USD?.trim();
  let usd = DEFAULT_STARTER_CREDIT_USD;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) usd = parsed;
  }
  usd = Math.min(usd, MAX_STARTER_CREDIT_USD);
  return Math.round(usd * MICRO_USD_PER_USD);
}

export interface StarterCreditDb {
  from: (table: string) => unknown;
  rpc?: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export interface StarterCreditDeps {
  /** The plan the user holds right now, or null. */
  resolveSubscription?: (userId: string) => Promise<{ plan: string; status: string } | null>;
  /** When the account signed up, or null when it can't be read. */
  resolveAccountCreatedAt?: (userId: string) => Promise<Date | null>;
  env?: Record<string, string | undefined>;
  now?: Date;
}

export interface StarterCreditResult {
  attempted: boolean;
  granted?: boolean;
  status?: string;
  amountMicroUsd?: number;
  skipped?: string;
}

async function defaultResolveSubscription(userId: string): Promise<{ plan: string; status: string } | null> {
  const { resolveEffectiveSubscription } = await import("@/lib/billing/instance-entitlement");
  const sub = await resolveEffectiveSubscription(userId, { throwOnQueryError: true });
  return sub ? { plan: sub.plan, status: sub.status } : null;
}

async function defaultResolveAccountCreatedAt(userId: string): Promise<Date | null> {
  const { clerkClient } = await import("@clerk/nextjs/server");
  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);
  return typeof user.createdAt === "number" ? new Date(user.createdAt) : null;
}

/** Grant the one-time starter credit when the user has an active paid plan. Never throws. */
export async function tryGrantStarterCredit(
  params: { userId: string } & StarterCreditDeps,
  dbArg?: StarterCreditDb | null
): Promise<StarterCreditResult> {
  try {
    const amountMicroUsd = starterCreditMicroUsd(params.env);
    if (amountMicroUsd <= 0) return { attempted: false, skipped: "disabled" };

    const db = dbArg ?? (supabaseAdmin as unknown as StarterCreditDb | null);
    if (!db || typeof db.rpc !== "function") return { attempted: false, skipped: "no_database" };

    const sub = await (params.resolveSubscription ?? defaultResolveSubscription)(params.userId);
    const paid = Boolean(sub && sub.plan !== "free" && (sub.status === "active" || sub.status === "trialing"));
    if (!paid) return { attempted: false, skipped: "no_paid_plan" };

    // The SQL function decides whether this sign-up time counts as a new account.
    const accountCreatedAt = await (params.resolveAccountCreatedAt ?? defaultResolveAccountCreatedAt)(params.userId);
    if (!accountCreatedAt) return { attempted: false, skipped: "no_account_created_at" };

    const { data, error } = await db.rpc("grant_starter_credit", {
      p_user_id: params.userId,
      p_amount_micro_usd: amountMicroUsd,
      p_account_created_at: accountCreatedAt.toISOString(),
      p_now: (params.now ?? new Date()).toISOString(),
    });
    if (error || !data || typeof data !== "object") {
      throw new Error(`grant_starter_credit failed: ${error?.message ?? "no result"}`);
    }
    const r = data as Record<string, unknown>;
    const granted = r.granted === true;
    const result: StarterCreditResult = {
      attempted: true,
      granted,
      status: String(r.status),
      amountMicroUsd: Number(r.amountMicroUsd ?? amountMicroUsd),
    };
    if (granted) {
      log.info("Starter credit granted", { source: SOURCE, userId: params.userId, amountMicroUsd: result.amountMicroUsd });
    }
    return result;
  } catch (error) {
    log.warn("Starter credit grant failed", {
      source: SOURCE,
      failureType: "starter_credit_failed",
      userId: params.userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { attempted: false, skipped: "error" };
  }
}

type Rows = { data: unknown; error: { message?: string } | null };
type Query = PromiseLike<Rows> & {
  select: (...a: unknown[]) => Query;
  eq: (...a: unknown[]) => Query;
  gte: (...a: unknown[]) => Query;
  maybeSingle: () => PromiseLike<Rows>;
};

/** The unspent part of the user's starter credit as a display line, or null. */
export async function getStarterCreditLine(
  userId: string,
  dbArg?: StarterCreditDb | null
): Promise<{ label: string; remainingMicroUsd: number } | null> {
  const db = dbArg ?? (supabaseAdmin as unknown as StarterCreditDb | null);
  if (!db) return null;
  const table = (name: string) => db.from(name) as Query;
  const { data: grant, error } = await table("managed_venice_card_ledger_entries")
    .select("amount_micro_usd, created_at")
    .eq("user_id", userId)
    .eq("reason", "starter_credit")
    .maybeSingle();
  if (error || !grant) return null;
  const g = grant as { amount_micro_usd: number | string; created_at: string };
  const { data: debits, error: debitError } = await table("managed_venice_card_ledger_entries")
    .select("amount_micro_usd")
    .eq("user_id", userId)
    .eq("reason", "managed_venice_debit")
    .gte("created_at", g.created_at);
  if (debitError) return null;
  const spent = (Array.isArray(debits) ? debits : []).reduce(
    (sum, d) => sum - Math.min(0, Number((d as { amount_micro_usd: number | string }).amount_micro_usd) || 0),
    0
  );
  const remaining = Math.max(0, Number(g.amount_micro_usd) - spent);
  if (remaining <= 0) return null;
  return { remainingMicroUsd: remaining, label: `$${(remaining / MICRO_USD_PER_USD).toFixed(2)} Starter credit` };
}
