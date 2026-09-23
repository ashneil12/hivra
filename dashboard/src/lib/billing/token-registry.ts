/**
 * The platform tokens Hivra accepts, and which one a moment in time runs on.
 *
 *   $HermesOS  the legacy Base token. Always registered. Before $HIVRA is
 *              active it is the only platform token. After activation it stays
 *              valid for the grandfathered cohort (see token-access.ts).
 *   $HIVRA     the new Base token. DORMANT until hivra-token-launch.ts carries
 *              its address and its activation instant has passed.
 *
 * Every token path (balances, tiers, quotes, settlement, sweeps, withdraws,
 * prices, the /token page) reads token identity from here. The $HermesOS
 * contract address below is the only copy in application code, and the $HIVRA
 * address lives only in hivra-token-launch.ts.
 *
 * Client-safe: no server imports, so wallet and /token UI can use it too.
 */
import { HIVRA_TOKEN_LAUNCH, type HivraTokenLaunchConfig } from "./hivra-token-launch";

export const BASE_CHAIN_ID = 8453;

export type PlatformTokenKey = "hermesos" | "hivra";
export const PLATFORM_TOKEN_KEYS: readonly PlatformTokenKey[] = ["hermesos", "hivra"];

export interface PlatformToken {
  key: PlatformTokenKey;
  /** Symbol persisted on snapshots, quotes and notifications. */
  symbol: string;
  /** How the product writes the token next to an amount. */
  displayUnit: string;
  name: string;
  chainId: number;
  /** Lower-cased contract address: the form every comparison uses. */
  address: string;
  /** The contract address exactly as published, for display and copy. */
  publishedAddress: string;
  decimals: number;
  /** Canonical DEX pool that prices the token, lower-cased; null = highest-liquidity Base pair. */
  poolId: string | null;
  /** When the token went live. Null for $HermesOS, which predates the registry. */
  activatesAt: Date | null;
  /** Quotes fail closed while the pricing pool holds less than this in USD. */
  minPriceLiquidityUsd: number;
}

/** Canonical Uniswap v4 pool id that prices $HermesOS. */
export const HERMESOS_POOL_ID = "0x336ad40640593281d9c519fa0994986817fce079a0c493ea08f7ed9cac55ff19";

/** The legacy $HermesOS contract on Base, as published on /token. */
export const HERMESOS_PUBLISHED_ADDRESS = "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3";

/**
 * Minimum USD liquidity of the pricing pool before a token quote is issued.
 * $HermesOS trades in a Uniswap v4 HermesOS/WETH pool with about $80k of
 * liquidity; $10k keeps quotes available through normal swings and stops them
 * if the pool is drained. $HIVRA launches into a fresh pool, and a thin pool is
 * what makes pump-quote-dump profitable, so its floor is higher. Ash decides the
 * final $HIVRA floor at activation (docs/token/HIVRA-ACTIVATION.md).
 */
export const HERMESOS_MIN_PRICE_LIQUIDITY_USD = 10_000;
export const HIVRA_MIN_PRICE_LIQUIDITY_USD = 25_000;

/**
 * Conversion grace: after a grandfathered $HermesOS user chooses to switch,
 * holding EITHER token keeps their tier for this long. After it, they are
 * evaluated in $HIVRA at the then-current threshold.
 */
export const TOKEN_CONVERSION_GRACE_HOURS = 72;

export const HERMESOS_TOKEN: PlatformToken = Object.freeze({
  key: "hermesos",
  symbol: "HermesOS",
  displayUnit: "$HermesOS",
  name: "HermesOS",
  chainId: BASE_CHAIN_ID,
  address: HERMESOS_PUBLISHED_ADDRESS.toLowerCase(),
  publishedAddress: HERMESOS_PUBLISHED_ADDRESS,
  decimals: 18,
  // The Uniswap v4 HermesOS/WETH pool on Base: the highest-liquidity pair,
  // which the price feed already used. Naming it stops a satellite pool from
  // ever pricing $HermesOS.
  poolId: HERMESOS_POOL_ID,
  activatesAt: null,
  minPriceLiquidityUsd: HERMESOS_MIN_PRICE_LIQUIDITY_USD,
});

export const HIVRA_SYMBOL = "HIVRA";
export const HIVRA_DISPLAY_UNIT = "$HIVRA";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const POOL_ID = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
// UTC only, to the second: "2026-10-01T16:00:00Z".
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// The EIP-55 checksum of a pasted mixed-case address is checked by
// hivra-token-launch.checksum.test.ts (it needs keccak, which this
// client-safe module does not load).

export type HivraLaunchValidation =
  | { status: "dormant" }
  | { status: "configured"; token: PlatformToken }
  | { status: "invalid"; errors: string[] };

/**
 * Check the launch block. Empty address and empty fields = dormant. Anything
 * else must be a complete, well-formed launch: a partial paste never activates.
 */
export function validateHivraLaunchConfig(
  config: HivraTokenLaunchConfig = HIVRA_TOKEN_LAUNCH
): HivraLaunchValidation {
  const address = (config.contractAddress ?? "").trim();
  const poolId = (config.poolId ?? "").trim();
  const activatesAt = (config.activatesAt ?? "").trim();
  if (!address && !poolId && !activatesAt) return { status: "dormant" };

  const errors: string[] = [];
  if (!EVM_ADDRESS.test(address) || ZERO_ADDRESS.test(address)) {
    errors.push("contractAddress must be a non-zero 0x-prefixed 20-byte address");
  } else if (address.toLowerCase() === HERMESOS_TOKEN.address) {
    errors.push("contractAddress is the legacy $HermesOS contract, not $HIVRA");
  }
  if (!Number.isInteger(config.decimals) || config.decimals < 0 || config.decimals > 36) {
    errors.push("decimals must be an integer between 0 and 36");
  }
  if (!POOL_ID.test(poolId)) {
    errors.push("poolId must be a 0x pool id (64 hex) or pair address (40 hex)");
  }
  const activatesAtMs = UTC_INSTANT.test(activatesAt) ? Date.parse(activatesAt) : Number.NaN;
  // Date.parse rolls impossible dates over (2026-02-30 → 2026-03-02); refuse them.
  if (!Number.isFinite(activatesAtMs) || new Date(activatesAtMs).toISOString().slice(0, 19) !== activatesAt.slice(0, 19)) {
    errors.push("activatesAt must be a real UTC instant to the second, e.g. 2026-10-01T16:00:00Z");
  }
  if (errors.length > 0) return { status: "invalid", errors };

  return {
    status: "configured",
    token: Object.freeze({
      key: "hivra",
      symbol: HIVRA_SYMBOL,
      displayUnit: HIVRA_DISPLAY_UNIT,
      name: "Hivra",
      chainId: BASE_CHAIN_ID,
      address: address.toLowerCase(),
      publishedAddress: address,
      decimals: config.decimals,
      poolId: poolId.toLowerCase(),
      activatesAt: new Date(activatesAtMs),
      minPriceLiquidityUsd: HIVRA_MIN_PRICE_LIQUIDITY_USD,
    }),
  };
}

let reportedInvalidLaunch = false;

/**
 * $HIVRA once its launch block is filled in (live or scheduled), else null. A
 * malformed block is reported once and treated as dormant: money paths never
 * run on a half-pasted address.
 */
export function getConfiguredHivraToken(
  config: HivraTokenLaunchConfig = HIVRA_TOKEN_LAUNCH
): PlatformToken | null {
  const validation = validateHivraLaunchConfig(config);
  if (validation.status === "configured") return validation.token;
  if (validation.status === "invalid" && !reportedInvalidLaunch) {
    reportedInvalidLaunch = true;
    // eslint-disable-next-line no-console
    console.error(
      `[token-registry] hivra-token-launch.ts is malformed; $HIVRA stays dormant: ${validation.errors.join("; ")}`
    );
  }
  return null;
}

export type HivraTokenPhase = "dormant" | "scheduled" | "active";

export function getHivraTokenPhase(
  now: Date = new Date(),
  config: HivraTokenLaunchConfig = HIVRA_TOKEN_LAUNCH
): HivraTokenPhase {
  const token = getConfiguredHivraToken(config);
  if (!token || !token.activatesAt) return "dormant";
  return now.getTime() >= token.activatesAt.getTime() ? "active" : "scheduled";
}

/** $HIVRA when it is live at `now`, else null. */
export function getActiveHivraToken(
  now: Date = new Date(),
  config: HivraTokenLaunchConfig = HIVRA_TOKEN_LAUNCH
): PlatformToken | null {
  return getHivraTokenPhase(now, config) === "active" ? getConfiguredHivraToken(config) : null;
}

export function isHivraActive(
  now: Date = new Date(),
  config: HivraTokenLaunchConfig = HIVRA_TOKEN_LAUNCH
): boolean {
  return getHivraTokenPhase(now, config) === "active";
}

/**
 * Tokens the platform reads and settles at `now`: $HermesOS always, $HIVRA once
 * active. Balance refreshes and transfer scans cover exactly these.
 */
export function livePlatformTokens(
  now: Date = new Date(),
  config: HivraTokenLaunchConfig = HIVRA_TOKEN_LAUNCH
): PlatformToken[] {
  const hivra = getActiveHivraToken(now, config);
  return hivra ? [HERMESOS_TOKEN, hivra] : [HERMESOS_TOKEN];
}

/** The token new users pay and hold in at `now`. */
export function primaryPlatformToken(
  now: Date = new Date(),
  config: HivraTokenLaunchConfig = HIVRA_TOKEN_LAUNCH
): PlatformToken {
  return getActiveHivraToken(now, config) ?? HERMESOS_TOKEN;
}

/**
 * The registered token for a key. $HIVRA resolves once its launch block is
 * configured (scheduled or live); before that there is no $HIVRA contract and
 * this returns null.
 */
export function platformTokenByKey(
  key: PlatformTokenKey,
  config: HivraTokenLaunchConfig = HIVRA_TOKEN_LAUNCH
): PlatformToken | null {
  if (key === "hermesos") return HERMESOS_TOKEN;
  return getConfiguredHivraToken(config);
}

/** Like platformTokenByKey, but a row naming an unconfigured token is a hard error. */
export function requirePlatformToken(
  key: PlatformTokenKey,
  config: HivraTokenLaunchConfig = HIVRA_TOKEN_LAUNCH
): PlatformToken {
  const token = platformTokenByKey(key, config);
  if (!token) throw new Error(`Platform token ${key} is not configured`);
  return token;
}

export function platformTokenByAddress(
  address: string | null | undefined,
  config: HivraTokenLaunchConfig = HIVRA_TOKEN_LAUNCH
): PlatformToken | null {
  const normalized = address?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === HERMESOS_TOKEN.address) return HERMESOS_TOKEN;
  const hivra = getConfiguredHivraToken(config);
  return hivra && hivra.address === normalized ? hivra : null;
}

export function isPlatformTokenKey(value: unknown): value is PlatformTokenKey {
  return value === "hermesos" || value === "hivra";
}

/**
 * The platform token a quote, subscription or lot row is denominated in, from
 * its stored contract address (legacy rows without one are $HermesOS). Throws
 * for an address the registry does not know: money never moves in a token
 * the platform cannot name.
 */
export function platformTokenForRow(
  row: { token_address?: string | null; tokenAddress?: string | null },
  config: HivraTokenLaunchConfig = HIVRA_TOKEN_LAUNCH
): PlatformToken {
  const address = row.token_address ?? row.tokenAddress ?? HERMESOS_TOKEN.address;
  const token = platformTokenByAddress(address, config);
  if (!token) throw new Error(`Unknown platform token ${address}`);
  return token;
}
