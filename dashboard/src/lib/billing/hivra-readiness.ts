/**
 * Whether $HIVRA is usable for payments and new holder tiers.
 *
 * Launching the token does not switch these on by itself. $HIVRA is usable
 * only while BOTH hold:
 *
 *   1. it is live in the registry (hivra-token-launch.ts filled in and its
 *      activation instant passed), and
 *   2. its pricing pool passes the live price gate right now: the same
 *      fetchPlatformTokenPriceUsd every $HIVRA quote runs (total liquidity
 *      floor, ETH-side floor, candle history and the deviation band). No
 *      threshold is restated here.
 *
 * A pass is served from the live-thresholds price cache while it is fresh
 * (LIVE_TTL_MS), so Billing page loads do not each call DEXScreener and
 * GeckoTerminal. A failure is remembered for READINESS_FAILURE_CACHE_MS for
 * the same reason. A failure of any kind (gate refusal, feed outage, timeout)
 * means "not usable": the check fails closed and never serves an older price.
 *
 * Who it applies to: accounts that may only pay and qualify in $HIVRA (not in
 * the $HermesOS grandfather cohort, after activation). Before activation, and
 * for grandfathered accounts, nothing here changes anything. Quotes already
 * issued, their settlement, existing tier rows and withdrawals are never
 * gated here.
 *
 * Server only.
 */
import { getGatedPlatformTokenPrice } from "./live-thresholds";
import { HERMESOS_TOKEN, getActiveHivraToken, type PlatformToken, type PlatformTokenKey } from "./token-registry";
import type { UserTokenAccess } from "./token-access";

/** What users are told while $HIVRA is not usable. Plain words, no price talk. */
export const HIVRA_NOT_READY_MESSAGE = "Token payments aren't available yet.";
export const HIVRA_NOT_READY_FAILURE_TYPE = "hivra_not_ready";

/** How long a failed readiness check is reused before the gate is asked again. */
export const READINESS_FAILURE_CACHE_MS = 60_000;

export type HivraReadiness =
  | { usable: true; token: PlatformToken }
  | { usable: false; reason: "not_live" | "price_gate" };

type GatedPriceFetch = Parameters<typeof getGatedPlatformTokenPrice>[0]["fetchImpl"];

interface ReadinessOptions {
  now?: Date;
  /** Test seam: replaces the gated price fetch. */
  fetchImpl?: GatedPriceFetch;
}

const failedAtByToken = new Map<string, number>();

/** Test seam. */
export function _resetHivraReadinessForTests() {
  failedAtByToken.clear();
}

export async function getHivraReadiness(options: ReadinessOptions = {}): Promise<HivraReadiness> {
  const now = options.now ?? new Date();
  const token = getActiveHivraToken(now);
  if (!token) return { usable: false, reason: "not_live" };

  const failedAt = failedAtByToken.get(token.address);
  if (failedAt !== undefined) {
    const age = now.getTime() - failedAt;
    if (age >= 0 && age < READINESS_FAILURE_CACHE_MS) return { usable: false, reason: "price_gate" };
  }

  try {
    await getGatedPlatformTokenPrice({ now, token, fetchImpl: options.fetchImpl });
    failedAtByToken.delete(token.address);
    return { usable: true, token };
  } catch (error) {
    failedAtByToken.set(token.address, now.getTime());
    // eslint-disable-next-line no-console
    console.info(
      `[hivra-readiness] ${token.displayUnit} payments and new tiers stay off: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { usable: false, reason: "price_gate" };
  }
}

export async function isHivraUsable(options: ReadinessOptions = {}): Promise<boolean> {
  return (await getHivraReadiness(options)).usable;
}

/**
 * True when this account's new token payments and tiers are in $HIVRA only:
 * $HIVRA is active and the account is not in the $HermesOS grandfather cohort.
 * Grandfathered accounts (converted or not) and every account before
 * activation are never gated by readiness.
 */
export function accessDependsOnHivraReadiness(access: Pick<UserTokenAccess, "phase" | "grandfathered">): boolean {
  return access.phase === "active" && !access.grandfathered;
}

/** A new $HIVRA payment or tier was asked for while $HIVRA is not usable. */
export class HivraNotReadyError extends Error {
  readonly status = 503;
  readonly failureType = HIVRA_NOT_READY_FAILURE_TYPE;
  constructor() {
    super(HIVRA_NOT_READY_MESSAGE);
    this.name = "HivraNotReadyError";
  }
}

/**
 * Refuse a NEW payment quote or tier in `tokenKey` for this account while
 * $HIVRA is not usable. No-op for $HermesOS, grandfathered accounts and
 * before activation.
 */
export async function assertHivraReadyFor(
  access: Pick<UserTokenAccess, "phase" | "grandfathered">,
  tokenKey: PlatformTokenKey,
  options: ReadinessOptions = {}
): Promise<void> {
  if (tokenKey !== "hivra" || !accessDependsOnHivraReadiness(access)) return;
  if (!(await isHivraUsable(options))) throw new HivraNotReadyError();
}

export interface TokenPaymentAvailability {
  /** Token payments and new holder tiers can be offered to this account. */
  available: boolean;
  /** The token this account pays in. */
  paymentToken: PlatformTokenKey;
  /** How the product writes that token, e.g. "$HIVRA". */
  displayUnit: string;
}

/** What Billing may offer this account in tokens right now. */
export async function resolveTokenPaymentAvailability(
  access: Pick<UserTokenAccess, "phase" | "grandfathered" | "paymentToken">,
  options: ReadinessOptions = {}
): Promise<TokenPaymentAvailability> {
  const now = options.now ?? new Date();
  const paymentToken = access.paymentToken;
  const displayUnit =
    paymentToken === "hivra" ? getActiveHivraToken(now)?.displayUnit ?? "$HIVRA" : HERMESOS_TOKEN.displayUnit;
  if (!accessDependsOnHivraReadiness(access)) return { available: true, paymentToken, displayUnit };
  return { available: await isHivraUsable(options), paymentToken, displayUnit };
}
