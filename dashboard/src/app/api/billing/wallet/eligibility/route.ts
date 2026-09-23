/**
 * Read-only readout of the user's current platform-token balance and tier
 * eligibility state, in the token the user's tier is held in (or, with no
 * tier yet, the token they would qualify in: $HermesOS before $HIVRA is
 * active and for the grandfather cohort, else $HIVRA). Used by the dashboard wallet page to render the
 * "your qualifying quantity is X — if balance drops below X your tier
 * eligibility ends" UX prominently.
 *
 * No state writes here. The cron `refresh-token-holdings` is the only
 * writer to `token_tier_qualifications`; this endpoint just reflects.
 */

import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { isBillingV2ServerEnabled, BILLING_V2_UNAVAILABLE_MESSAGE } from "@/lib/billing/billing-v2-availability";
import { isCryptoBillingEnabled } from "@/lib/billing/crypto-availability";
import {
  HERMESOS_TOKEN_DECIMALS,
  isFoundersRateUser,
} from "@/lib/billing/tier-thresholds";
import {
  getLiveActiveThresholds,
  LivePriceUnavailableError,
} from "@/lib/billing/live-thresholds";
import { supabaseAdmin } from "@/lib/supabase";
import {
  BASE_CHAIN_ID,
  getVvvStakingContractAddress,
  VVV_TOKEN_ADDRESS,
  VVV_TOKEN_DECIMALS,
} from "@/lib/billing/token-holdings";
import { requirePlatformToken, type PlatformTokenKey } from "@/lib/billing/token-registry";
import { resolveUserTokenAccess } from "@/lib/billing/token-access";
import {
  VENICE_BOOST_CPU,
  VENICE_BOOST_RAM_MB,
  VENICE_BOOST_USD_THRESHOLD,
} from "@/lib/services/tier-specs";
import { fetchVvvPriceUsd, computeTokensRequiredForUsdTarget } from "@/lib/billing/price-feed";
import { log } from "@/lib/logger";

const LOG_CONTEXT = {
  source: "billing/wallet-eligibility",
  route: "/api/billing/wallet/eligibility",
  method: "GET",
};

interface SnapshotRow {
  wallet_address: string | null;
  normalized_wallet_address: string | null;
  balance_raw: string;
  balance_display: string;
  checked_at: string;
}

interface QualificationRow {
  tier: "pro" | "power";
  token_key?: PlatformTokenKey | null;
  qualifying_quantity: string;
  threshold_at_qualification: string;
  qualified_at: string;
  currently_eligible: boolean;
  last_balance_seen: string | null;
  last_evaluated_at: string | null;
  last_breach_at: string | null;
}

interface TierState {
  currentlyEligible: boolean;
  qualifyingQuantity: string | null;       // base units, as string for JSON safety
  qualifyingQuantityDisplay: string | null; // human-readable
  thresholdAtQualification: string | null;
  qualifiedAt: string | null;
  lastBreachAt: string | null;
  currentThreshold: string | null;
  currentThresholdDisplay: string | null;
  /** Token the tier is held in, when held. */
  tokenKey: PlatformTokenKey | null;
}

function formatTokenAmount(raw: bigint, decimals = HERMESOS_TOKEN_DECIMALS): string {
  if (decimals === 0) return raw.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toLocaleString("en-US");
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fracStr === "") return whole.toLocaleString("en-US");
  return `${whole.toLocaleString("en-US")}.${fracStr.slice(0, 4)}`;
}

function buildTierState(
  qualification: QualificationRow | undefined,
  currentThreshold: bigint | null
): TierState {
  return {
    currentlyEligible: qualification?.currently_eligible ?? false,
    qualifyingQuantity: qualification?.qualifying_quantity ?? null,
    qualifyingQuantityDisplay: qualification
      ? formatTokenAmount(BigInt(qualification.qualifying_quantity))
      : null,
    thresholdAtQualification: qualification?.threshold_at_qualification ?? null,
    qualifiedAt: qualification?.qualified_at ?? null,
    lastBreachAt: qualification?.last_breach_at ?? null,
    currentThreshold: currentThreshold !== null ? currentThreshold.toString() : null,
    currentThresholdDisplay: currentThreshold !== null ? formatTokenAmount(currentThreshold) : null,
    tokenKey: qualification ? (qualification.token_key === "hivra" ? "hivra" : "hermesos") : null,
  };
}

export async function GET() {
  let userIdForLog: string | null = null;
  try {
    // Token/wallet surfaces share one consistent gate (see token-holding route):
    // require BOTH billing-v2 and crypto billing so the wallet and billing pages
    // never disagree about whether token holdings are available.
    if (!isBillingV2ServerEnabled() || !isCryptoBillingEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }

    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Qualification rows for both tiers, if present.
    const { data: qualRows, error: qualError } = await supabaseAdmin
      .from("token_tier_qualifications")
      // ::text on numeric columns to dodge JSON-Number precision loss
      // for values that exceed 2^53 base units.
      .select(
        "tier, token_key, qualifying_quantity::text, threshold_at_qualification::text, qualified_at, currently_eligible, last_balance_seen::text, last_evaluated_at, last_breach_at"
      )
      .eq("user_id", userId);

    if (qualError) {
      return apiError("Failed to load qualifications", 500, {
        failureType: "wallet_eligibility_qualifications_failed",
      }, undefined, {
        ...LOG_CONTEXT,
        userId,
        failureType: "wallet_eligibility_qualifications_failed",
        cause: qualError,
      });
    }

    const quals = (qualRows as QualificationRow[] | null) ?? [];
    const proQual = quals.find((q) => q.tier === "pro");
    const powerQual = quals.find((q) => q.tier === "power");

    // The readout token: the token a held tier is in (Power first), else the
    // first token this user may newly qualify in.
    const access = await resolveUserTokenAccess(userId, { recordMembership: false });
    const heldTokenKey = (powerQual ?? proQual)?.token_key;
    const tokenKey: PlatformTokenKey = heldTokenKey
      ? heldTokenKey === "hivra" ? "hivra" : "hermesos"
      : access.qualifyTokens[0];
    const token = requirePlatformToken(tokenKey);

    // Latest balance snapshot in the readout token. The snapshot table
    // also stores other token balances (for example VVV); without these
    // token filters a newer zero-balance companion token snapshot can be
    // mislabeled as the user's Hivra balance and disable withdraw.
    const { data: snapRows, error: snapError } = await supabaseAdmin
      .from("token_holding_snapshots")
      // ::text cast prevents JSON-Number precision loss for values > 2^53.
      .select("wallet_address, normalized_wallet_address, balance_raw::text, balance_display, checked_at")
      .eq("user_id", userId)
      .eq("chain_id", BASE_CHAIN_ID)
      .eq("token_address", token.address)
      .order("checked_at", { ascending: false })
      .limit(1);

    if (snapError) {
      return apiError("Failed to load balance snapshot", 500, {
        failureType: "wallet_eligibility_snapshot_failed",
        tokenAddress: token.address,
        chainId: BASE_CHAIN_ID,
      }, undefined, {
        ...LOG_CONTEXT,
        userId,
        failureType: "wallet_eligibility_snapshot_failed",
        cause: snapError,
      });
    }

    const snapshot = (snapRows as SnapshotRow[] | null)?.[0] ?? null;

    if (!snapshot && (proQual || powerQual)) {
      log.warn("qualified user has no Hivra balance snapshot", {
        ...LOG_CONTEXT,
        userId,
        failureType: "wallet_eligibility_missing_hermes_snapshot",
        hasProQualification: Boolean(proQual),
        hasPowerQualification: Boolean(powerQual),
      });
    }

    let live;
    try {
      // Allowlisted founders see the launch-epoch readout past the global
      // promo window; everyone else gets the date-driven epoch.
      live = await getLiveActiveThresholds({
        forceLaunchEpoch: isFoundersRateUser(userId),
        token,
      });
    } catch (error) {
      if (error instanceof LivePriceUnavailableError) {
        return apiError(
          "Token price unavailable — please try again later.",
          503,
          { failureType: "wallet_eligibility_price_unavailable" }
        );
      }
      throw error;
    }
    const proThreshold = live.pro.amount;
    const powerThreshold = live.power.amount;

    // Venice compute boost: surface the user's VVV holding + persisted
    // boost-eligibility state. Reflects the authoritative cron-written row
    // (no live DEX call here) plus the latest VVV balance snapshot.
    const { data: vvvSnapRows } = await supabaseAdmin
      .from("token_holding_snapshots")
      .select("balance_raw::text, balance_display, checked_at")
      .eq("user_id", userId)
      .eq("chain_id", BASE_CHAIN_ID)
      .eq("token_address", VVV_TOKEN_ADDRESS)
      .order("checked_at", { ascending: false })
      .limit(1);
    const vvvSnap = (vvvSnapRows as Array<{
      balance_raw: string;
      balance_display: string;
      checked_at: string;
    }> | null)?.[0] ?? null;

    const { data: boostRow } = await supabaseAdmin
      .from("venice_compute_boost_qualifications")
      .select("currently_eligible, last_usd_value::text, last_evaluated_at, last_breach_at")
      .eq("user_id", userId)
      .maybeSingle<{
        currently_eligible: boolean;
        last_usd_value: string | null;
        last_evaluated_at: string | null;
        last_breach_at: string | null;
      }>();

    // Live VVV/USD price → the whole-token VVV amount needed to clear the
    // $199 threshold, so the boost card can say "Hold at least N VVV" exactly
    // like the Pro/Power cards. Best-effort: a DEX outage just omits the number.
    let requiredVvvDisplay: string | null = null;
    let vvvPriceUsd: string | null = null;
    try {
      const vvvPrice = await fetchVvvPriceUsd();
      vvvPriceUsd = vvvPrice.priceUsd;
      const required = computeTokensRequiredForUsdTarget({
        usdTargetCents: VENICE_BOOST_USD_THRESHOLD * 100,
        priceUsdPerToken: vvvPrice.priceUsd,
        tokenDecimals: VVV_TOKEN_DECIMALS,
      });
      requiredVvvDisplay = formatTokenAmount(required.raw, VVV_TOKEN_DECIMALS);
    } catch {
      // best-effort — card falls back to the "$199 of VVV" phrasing.
    }

    return apiSuccess({
      tokenKey: token.key,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      tokenAddress: token.publishedAddress,
      tokenAccess: {
        phase: access.phase,
        grandfathered: access.grandfathered,
        allowedTokens: access.allowedTokens,
        paymentToken: access.paymentToken,
        convertedAt: access.convertedAt?.toISOString() ?? null,
        conversionGraceEndsAt: access.conversionGraceEndsAt?.toISOString() ?? null,
      },
      balance: snapshot
        ? {
            balanceRaw: snapshot.balance_raw,
            balanceDisplay: snapshot.balance_display,
            walletAddress: snapshot.wallet_address,
            normalizedWalletAddress: snapshot.normalized_wallet_address,
            // The DB column is `checked_at`; the wire shape preserves the
            // older `capturedAt` JS name so the dashboard UI doesn't break.
            capturedAt: snapshot.checked_at,
          }
        : null,
      thresholds: {
        configured: true,
        proRaw: proThreshold.toString(),
        proDisplay: formatTokenAmount(proThreshold),
        powerRaw: powerThreshold.toString(),
        powerDisplay: formatTokenAmount(powerThreshold),
        priceUsd: live.priceUsd,
        priceFetchedAt: live.priceFetchedAt.toISOString(),
        epoch: live.epoch,
      },
      tiers: {
        pro: buildTierState(proQual, proThreshold),
        power: buildTierState(powerQual, powerThreshold),
      },
      veniceBoost: {
        thresholdUsd: VENICE_BOOST_USD_THRESHOLD,
        cpuBonus: VENICE_BOOST_CPU,
        ramBonusMb: VENICE_BOOST_RAM_MB,
        currentlyEligible: boostRow?.currently_eligible ?? false,
        lastUsdValue: boostRow?.last_usd_value ?? null,
        lastEvaluatedAt: boostRow?.last_evaluated_at ?? null,
        lastBreachAt: boostRow?.last_breach_at ?? null,
        vvvBalanceRaw: vvvSnap?.balance_raw ?? null,
        vvvBalanceDisplay: vvvSnap?.balance_display ?? null,
        requiredVvvDisplay,
        vvvPriceUsd,
        // When a VVV staking contract is configured, the snapshot's VVV balance
        // already includes staked VVV — drives the "staked counts too" copy.
        countsStakedVvv: Boolean(getVvvStakingContractAddress()),
      },
    });
  } catch (error) {
    return apiError("Failed to load wallet eligibility", 500, {
      failureType: "wallet_eligibility_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      ...LOG_CONTEXT,
      userId: userIdForLog,
      failureType: "wallet_eligibility_failed",
      cause: error,
    });
  }
}
