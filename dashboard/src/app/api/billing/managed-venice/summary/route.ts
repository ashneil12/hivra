import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  MANAGED_VENICE_USER_LAUNCH_SUBSIDY_CAP_MICRO_USD,
  MANAGED_VENICE_WEEKLY_SUBSIDY_LIMIT_MICRO_USD,
  resolveManagedVeniceDiscount,
} from "@/lib/billing/managed-venice-discounts";
import { getManagedVeniceWalletSummary } from "@/lib/billing/managed-venice-wallets";
import { supabaseAdmin } from "@/lib/supabase";
import { listManagedVeniceProxyKeys } from "@/lib/venice/proxy-keys";

// A transient upstream network blip (Supabase or the Venice proxy) surfaces in
// Node as a bare `TypeError: fetch failed` with no further detail. Without a
// retry it hard-500s the whole billing summary for the user (~1/9h in prod),
// even though the underlying billing data is fine on a second attempt.
function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|UND_ERR/i.test(
    message
  );
}

// Run `load` once; on a transient network error wait briefly and retry exactly
// once. A non-transient error (schema, auth, logic) still fails fast — no point
// retrying those — and a second transient failure falls through to the caller's
// existing 500 path. Touches no billing logic; worst case is one extra attempt.
async function loadWithTransientRetry<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (!isTransientNetworkError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return load();
  }
}

function formatTokenDisplay(rawValue: string) {
  const raw = BigInt(rawValue || "0");
  const whole = raw / 10n ** 18n;
  return `${Number(whole).toLocaleString("en-US")} Hivra`;
}

async function loadSubsidyState(userId: string) {
  if (!supabaseAdmin) {
    return {
      launchSubsidyUsedMicroUsd: 0,
      weeklySubsidyUsedMicroUsd: 0,
      killSwitchActive: false,
    };
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from("managed_venice_financial_events")
    .select("discount_micro_usd, metadata, created_at")
    .eq("user_id", userId)
    .eq("event_type", "subsidy_applied");

  const events = Array.isArray(data) ? data : [];
  let launchSubsidyUsedMicroUsd = 0;
  let weeklySubsidyUsedMicroUsd = 0;
  for (const event of events as Array<{ discount_micro_usd?: number; metadata?: Record<string, unknown>; created_at?: string }>) {
    const launchPart =
      typeof event.metadata?.launchSubsidyMicroUsd === "number"
        ? event.metadata.launchSubsidyMicroUsd
        : event.metadata?.rate === "launch_20"
          ? event.discount_micro_usd || 0
          : 0;
    launchSubsidyUsedMicroUsd += launchPart;
    if (event.created_at && event.created_at >= since) {
      weeklySubsidyUsedMicroUsd += event.discount_micro_usd || 0;
    }
  }

  const { data: state } = await supabaseAdmin
    .from("managed_venice_platform_state")
    .select("weekly_kill_switch_active, weekly_subsidy_used_micro_usd")
    .eq("id", "global")
    .maybeSingle();

  return {
    launchSubsidyUsedMicroUsd,
    weeklySubsidyUsedMicroUsd:
      typeof state?.weekly_subsidy_used_micro_usd === "number"
        ? state.weekly_subsidy_used_micro_usd
        : weeklySubsidyUsedMicroUsd,
    killSwitchActive: Boolean(state?.weekly_kill_switch_active),
  };
}

export async function GET() {
  let userIdForLog: string | null = null;
  try {
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    const [wallets, keys, subsidyState] = await loadWithTransientRetry(() =>
      Promise.all([
        getManagedVeniceWalletSummary(userId),
        listManagedVeniceProxyKeys(userId),
        loadSubsidyState(userId),
      ])
    );
    const discount = resolveManagedVeniceDiscount({
      walletType: "hermesos",
      userLaunchSubsidyUsedMicroUsd: subsidyState.launchSubsidyUsedMicroUsd,
      weeklySubsidyUsedMicroUsd: subsidyState.weeklySubsidyUsedMicroUsd,
      killSwitchActive: subsidyState.killSwitchActive,
    });

    return apiSuccess({
      wallets: {
        hermesos: {
          tokenDisplay: formatTokenDisplay(wallets.hermesos.remainingTokenAmountRaw),
          lockedValueMicroUsd: wallets.hermesos.totalValueMicroUsd,
          availableMicroUsd: wallets.hermesos.availableMicroUsd,
          reservedMicroUsd: wallets.hermesos.reservedMicroUsd,
          lots: [],
        },
        card: {
          balanceMicroUsd: wallets.card.totalValueMicroUsd,
          availableMicroUsd: wallets.card.availableMicroUsd,
          reservedMicroUsd: wallets.card.reservedMicroUsd,
        },
      },
      discount: {
        rate: discount.rate,
        discountBps: discount.discountBps,
        launchSubsidyUsedMicroUsd: subsidyState.launchSubsidyUsedMicroUsd,
        launchSubsidyCapMicroUsd: MANAGED_VENICE_USER_LAUNCH_SUBSIDY_CAP_MICRO_USD,
      },
      killSwitch: {
        active: subsidyState.killSwitchActive,
        weeklySubsidyUsedMicroUsd: subsidyState.weeklySubsidyUsedMicroUsd,
        thresholdMicroUsd: MANAGED_VENICE_WEEKLY_SUBSIDY_LIMIT_MICRO_USD,
      },
      keys,
    });
  } catch (error) {
    // Surface the real error in ops telemetry. Without this the feed only
    // got `errorName: "Error"` and the underlying cause (missing table,
    // missing supabase admin, etc.) was invisible. `details` flows through
    // sanitizeOpsMetadata, which strips secrets/tokens — schema errors like
    // "relation X does not exist" are safe to keep.
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return apiError(
      "Failed to load managed Venice summary.",
      500,
      {
        failureType: "managed_venice_summary_failed",
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage,
      },
      undefined,
      {
        source: "billing/managed-venice/summary",
        route: "/api/billing/managed-venice/summary",
        method: "GET",
        userId: userIdForLog,
        failureType: "managed_venice_summary_failed",
        cause: error,
      }
    );
  }
}
