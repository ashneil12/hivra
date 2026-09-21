// Managed-Venice auto-recovery — reactivate a proxy key that was paused for an
// uncovered overage, once the user's wallet is funded again.
//
// Deliberately does NOT move money: it only flips key status paused→active when
// there's spendable balance. The overage that caused the pause stays an open
// reconciliation item and is settled offline by the existing invoice cron — so
// this can't double-charge or mis-debit. Worst case it reactivates a key that
// then hits the normal insufficient-balance 402 on its next request (harmless).
//
// Off by default (MANAGED_VENICE_AUTO_RECOVER_ENABLED). Today a paused key needs
// a manual ops unpause; this closes that gap. Call it after a top-up settles and
// from the reconciliation cron as a backstop.

import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";
import { getManagedVeniceWalletSummary } from "@/lib/billing/managed-venice-wallets";

type QueryError = { code?: string; message?: string } | null;

type DbUpdateFilter = {
  eq: (...args: unknown[]) => DbUpdateFilter;
  select: (...args: unknown[]) => Promise<{ data?: unknown; error: QueryError }>;
};
type DbUpdateChain = { update: (...args: unknown[]) => DbUpdateFilter };

type SupabaseLike = { from: (table: string) => unknown };

// The only pause reason this recovers: an uncovered overage at chat settlement
// (see proxy-settlement.ts markManagedVeniceReconciliationRequired). Keys paused
// for any other reason are left for manual review.
export const OVERAGE_PAUSE_REASON = "managed_venice_overage_uncovered";

export function isManagedVeniceAutoRecoverEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.MANAGED_VENICE_AUTO_RECOVER_ENABLED === "true";
}

export interface AutoRecoverResult {
  reactivated: number;
  reason: "disabled" | "no_balance" | "no_paused_keys" | "reactivated";
}

// Reactivate this user's overage-paused proxy keys if their wallet now has any
// spendable balance. Returns the count reactivated. Safe to call repeatedly:
// once keys are active the WHERE clause matches nothing.
export async function tryReactivateManagedVeniceKeysAfterTopUp(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin,
  env: Record<string, string | undefined> = process.env
): Promise<AutoRecoverResult> {
  if (!isManagedVeniceAutoRecoverEnabled(env)) return { reactivated: 0, reason: "disabled" };
  const client = requireDb(db) as SupabaseLike;

  const summary = await getManagedVeniceWalletSummary(userId, client);
  const available =
    summary.hermesos.availableMicroUsd + summary.card.availableMicroUsd;
  if (available <= 0) return { reactivated: 0, reason: "no_balance" };

  const { data, error } = await (client.from("managed_venice_proxy_keys") as DbUpdateChain)
    .update({
      status: "active",
      paused_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("status", "paused")
    .eq("paused_reason", OVERAGE_PAUSE_REASON)
    .select("id");
  if (error) {
    throw new Error(error.message || "Failed to reactivate managed Venice proxy keys");
  }
  const reactivated = Array.isArray(data) ? data.length : 0;
  return {
    reactivated,
    reason: reactivated > 0 ? "reactivated" : "no_paused_keys",
  };
}
