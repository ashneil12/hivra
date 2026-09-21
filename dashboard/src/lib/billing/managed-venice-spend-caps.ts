// Managed-Venice per-user monthly spend cap — a purely PROTECTIVE control.
// It can only block spend above a ceiling; it never charges, refunds, or moves
// money. Off by default: with MANAGED_VENICE_SPEND_CAPS_ENABLED unset (or no
// resolvable cap) every call is a no-op and behavior is byte-identical to today.
//
// Enforced at reservation time (reserveManagedVeniceChatRequest) so any chat
// caller is covered from one place. A breach throws ManagedVeniceSpendCapError,
// which the proxy route turns into a 402 with a top-up/upgrade hint.

import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";

type QueryError = { code?: string; message?: string } | null;

type DbSelectChain = {
  select: (...args: unknown[]) => DbSelectChain;
  eq: (...args: unknown[]) => DbSelectChain;
  gte: (...args: unknown[]) => DbSelectChain;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type SupabaseLike = { from: (table: string) => unknown };

export class ManagedVeniceSpendCapError extends Error {
  readonly capMicroUsd: number;
  readonly spentMicroUsd: number;
  constructor(capMicroUsd: number, spentMicroUsd: number) {
    super("Managed Venice monthly spend cap reached");
    this.name = "ManagedVeniceSpendCapError";
    this.capMicroUsd = capMicroUsd;
    this.spentMicroUsd = spentMicroUsd;
  }
}

export interface ManagedVeniceSpendCapConfig {
  enabled: boolean;
  /** Platform-default monthly cap in microdollars, or null when unset. */
  capMicroUsd: number | null;
}

function parseUsd(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : null;
}

// Flag + default cap come from env so this ships dark and is tuned without a
// deploy. A per-user override (looser/tighter than the platform default) is a
// deliberate follow-up — see managed-Venice follow-up.
export function resolveManagedVeniceSpendCapConfig(
  env: Record<string, string | undefined> = process.env
): ManagedVeniceSpendCapConfig {
  return {
    enabled: env.MANAGED_VENICE_SPEND_CAPS_ENABLED === "true",
    capMicroUsd: parseUsd(env.MANAGED_VENICE_MONTHLY_SPEND_CAP_USD),
  };
}

/** First instant of the current calendar month, UTC, as an ISO string. */
export function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// Sum charged_micro_usd across this user's usage events since the start of the
// current UTC month. Charged (not actual) is the user-facing figure the cap
// governs — reconciliation refunds reduce future months, not this query.
export async function getManagedVeniceMonthlySpendMicroUsd(
  userId: string,
  now: Date,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<number> {
  const client = requireDb(db) as SupabaseLike;
  const { data, error } = await (client.from("managed_venice_usage_events") as DbSelectChain)
    .select("charged_micro_usd")
    .eq("user_id", userId)
    .gte("created_at", monthStartIso(now));
  if (error) {
    throw new Error(error.message || "Failed to read managed Venice monthly spend");
  }
  const rows = (Array.isArray(data) ? data : []) as Array<{ charged_micro_usd?: unknown }>;
  return rows.reduce((sum, row) => {
    const v = row.charged_micro_usd;
    return sum + (typeof v === "number" && Number.isFinite(v) ? v : 0);
  }, 0);
}

// Throw if charging `addMicroUsd` would push this month's spend over the cap.
// No-op when caps are disabled or no cap is configured.
export async function assertManagedVeniceWithinSpendCap(
  params: { userId: string; addMicroUsd: number; now?: Date },
  db: SupabaseLike | null | undefined = supabaseAdmin,
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  const config = resolveManagedVeniceSpendCapConfig(env);
  if (!config.enabled || config.capMicroUsd === null) return;
  const now = params.now ?? new Date();
  const spent = await getManagedVeniceMonthlySpendMicroUsd(params.userId, now, db);
  if (spent + Math.max(0, params.addMicroUsd) > config.capMicroUsd) {
    throw new ManagedVeniceSpendCapError(config.capMicroUsd, spent);
  }
}
