/**
 * Server side of the token geo-policy (./token-geo-policy.ts). Every token
 * route asks `resolveTokenGeoBlock` instead of reading a country itself.
 *
 * Signals, either of which blocks:
 * - `x-vercel-ip-country`, the request's IP country as Vercel's edge sets it.
 *   Missing, "XX" (unknown) or "T1" (Tor) is NOT blocked: self-hosted
 *   installs have no Vercel edge, and an unknown IP is not evidence of a
 *   country. The stored signal still applies to a signed-in user.
 * - the user's stored country: `signup_risk_assessments.country_code`, the IP
 *   country the free-tier abuse check recorded at sign-up (proxycheck). Only
 *   users that check assessed have one. Hivra stores no billing address, and
 *   the Stripe card's issuing country is not kept.
 * - with no request (crons deciding a new tier qualification): the stored
 *   country, and the country Clerk recorded for the user's latest session
 *   activity (its IP geo), which stands in for the request IP.
 *
 * With an empty policy this module reads nothing: no header, no query.
 *
 * What it gates is NEW token actions only (quotes, a first tier qualification,
 * a first wallet verification, conversion). Existing tier rows, yearly years,
 * deposit lots, withdrawals, settlement of quotes already issued, and card
 * payments never consult it.
 */
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

import {
  TOKEN_GEO_POLICY,
  isCountryBlockedForTokens,
  isTokenGeoPolicyActive,
  normalizeCountryCode,
  tokenGeoNotice,
  type TokenGeoPolicy,
} from "./token-geo-policy";

export const VERCEL_IP_COUNTRY_HEADER = "x-vercel-ip-country";

export type TokenGeoSignal = "ip_country" | "stored_country";

export type TokenGeoDecision =
  | { blocked: false }
  | { blocked: true; country: string; signal: TokenGeoSignal; message: string };

export const TOKEN_GEO_NOT_BLOCKED: TokenGeoDecision = Object.freeze({ blocked: false as const });

type HeadersLike = { get(name: string): string | null };
/** A Request/NextRequest, a Headers object (next/headers), or nothing. */
export type TokenGeoRequest = { headers: HeadersLike } | HeadersLike | null | undefined;

export interface TokenGeoOptions {
  /** Test seam; defaults to the committed TOKEN_GEO_POLICY. */
  policy?: TokenGeoPolicy;
  /** Test seam; defaults to readStoredTokenCountry. */
  readStoredCountry?: (userId: string) => Promise<string | null>;
  /** Test seam; defaults to readLatestSessionCountry. */
  readSessionCountry?: (userId: string) => Promise<string | null>;
}

const LOG_SOURCE = "compliance/token-geo";

function headersOf(request: TokenGeoRequest): HeadersLike | null {
  if (!request) return null;
  if (typeof (request as HeadersLike).get === "function") return request as HeadersLike;
  const headers = (request as { headers?: HeadersLike }).headers;
  return headers && typeof headers.get === "function" ? headers : null;
}

function readIpCountry(request: TokenGeoRequest): string | null {
  return normalizeCountryCode(headersOf(request)?.get(VERCEL_IP_COUNTRY_HEADER) ?? null);
}

/** The stored sign-up country for a user, or null (none, or the read failed). */
export async function readStoredTokenCountry(userId: string): Promise<string | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("signup_risk_assessments")
      .select("country_code")
      .eq("user_id", userId)
      .maybeSingle<{ country_code: string | null }>();
    if (error) {
      log.warn("token geo: stored country read failed; treating it as unknown", {
        source: LOG_SOURCE,
        userId,
        failureType: "token_geo_stored_country_read_failed",
        errorCode: (error as { code?: string }).code,
      });
      return null;
    }
    return normalizeCountryCode(data?.country_code ?? null);
  } catch (error) {
    log.warn("token geo: stored country read threw; treating it as unknown", {
      source: LOG_SOURCE,
      userId,
      failureType: "token_geo_stored_country_read_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

const CLERK_API = "https://api.clerk.com/v1";
const CLERK_TIMEOUT_MS = 5_000;

/**
 * The country Clerk recorded for the user's latest session activity (an ISO
 * code or an English name), or null: no session, no Clerk key (self-host), or
 * the read failed. Same source as the sync-user-geo cron.
 */
export async function readLatestSessionCountry(userId: string): Promise<string | null> {
  const key = process.env.CLERK_SECRET_KEY?.trim();
  if (!key) return null;
  try {
    const response = await fetch(`${CLERK_API}/sessions?user_id=${encodeURIComponent(userId)}&limit=1`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn("token geo: Clerk session country read failed; treating it as unknown", {
        source: LOG_SOURCE,
        userId,
        failureType: "token_geo_session_country_read_failed",
        status: response.status,
      });
      return null;
    }
    const sessions = (await response.json()) as Array<{ latest_activity?: { country?: unknown } }> | null;
    const country = Array.isArray(sessions) ? sessions[0]?.latest_activity?.country : undefined;
    return typeof country === "string" && country.trim() ? country.trim() : null;
  } catch (error) {
    log.warn("token geo: Clerk session country read threw; treating it as unknown", {
      source: LOG_SOURCE,
      userId,
      failureType: "token_geo_session_country_read_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

function blockedDecision(country: string, signal: TokenGeoSignal): TokenGeoDecision {
  return { blocked: true, country, signal, message: tokenGeoNotice(country) };
}

/**
 * Whether this request may start a NEW token action. Blocks when the IP
 * country or the user's stored country is in the policy. The empty policy
 * returns "not blocked" before reading anything.
 */
export async function resolveTokenGeoBlock(
  request: TokenGeoRequest,
  user: { userId: string | null | undefined } | null,
  options: TokenGeoOptions = {}
): Promise<TokenGeoDecision> {
  const policy = options.policy ?? TOKEN_GEO_POLICY;
  if (!isTokenGeoPolicyActive(policy)) return TOKEN_GEO_NOT_BLOCKED;

  const ipCountry = readIpCountry(request);
  if (ipCountry && isCountryBlockedForTokens(ipCountry, policy)) {
    return blockedDecision(ipCountry, "ip_country");
  }

  const userId = user?.userId;
  if (userId) {
    const stored = await (options.readStoredCountry ?? readStoredTokenCountry)(userId);
    if (stored && isCountryBlockedForTokens(stored, policy)) {
      return blockedDecision(stored, "stored_country");
    }
  }
  return TOKEN_GEO_NOT_BLOCKED;
}

/**
 * Whether a NEW token-tier qualification row may be recorded. Existing rows
 * are never passed here. A caller that resolved a request passes its decision
 * (IP + stored). Without one (crons, and routes that don't pass it) the stored
 * country and Clerk's latest-session country decide.
 */
export async function isNewTokenQualificationRefused(
  userId: string,
  decision?: TokenGeoDecision,
  options: TokenGeoOptions = {}
): Promise<boolean> {
  const policy = options.policy ?? TOKEN_GEO_POLICY;
  if (!isTokenGeoPolicyActive(policy)) return false;
  if (decision) return decision.blocked;
  const stored = await (options.readStoredCountry ?? readStoredTokenCountry)(userId);
  if (stored && isCountryBlockedForTokens(stored, policy)) return true;
  const session = await (options.readSessionCountry ?? readLatestSessionCountry)(userId);
  return Boolean(session && isCountryBlockedForTokens(session, policy));
}

/**
 * Whether the user already has token access to protect: any tier
 * qualification row, or a verified wallet that is theirs or a legacy
 * $HermesOS lock wallet (not the credit-deposit address every crypto payment
 * provisions). Such a user may still verify a wallet while blocked, so moving
 * tokens (or retiring a lock wallet into their own wallet) never costs them
 * the tier they hold. Throws when it cannot read, so a route fails rather
 * than guessing.
 */
export async function hasExistingTokenHolderAccess(userId: string): Promise<boolean> {
  if (!supabaseAdmin) throw new Error("Database not configured");

  const { data: rows, error: rowsError } = await supabaseAdmin
    .from("token_tier_qualifications")
    .select("id")
    .eq("user_id", userId)
    .limit(1);
  if (rowsError) throw new Error("Failed to read token tier qualifications");
  if (Array.isArray(rows) && rows.length > 0) return true;

  const { data: wallets, error: walletsError } = await supabaseAdmin
    .from("user_wallets")
    .select("verification_method, metadata")
    .eq("user_id", userId)
    .eq("chain_type", "evm")
    .not("verified_at", "is", null)
    .limit(50);
  if (walletsError) throw new Error("Failed to read verified wallets");
  // The same rule as a token verification wallet (token-holdings.ts
  // isEligiblePrimaryTokenWallet): any signature/admin wallet, and a Bankr
  // wallet with no purpose (older holders) or a lock wallet. A payment
  // deposit address (credit_deposit) is not token access.
  return ((wallets ?? []) as Array<{ verification_method: string | null; metadata: unknown }>).some((wallet) => {
    if (wallet.verification_method === "signature" || wallet.verification_method === "admin") return true;
    const bankr = (wallet.metadata as { bankr?: { purpose?: unknown } } | null)?.bankr;
    const purpose = typeof bankr?.purpose === "string" ? bankr.purpose : null;
    if (wallet.verification_method === "bankr") return !purpose || purpose === "hermesos_lock";
    return !purpose;
  });
}

/**
 * Whether the user already has a tier qualification row for this tier (in any
 * state). A blocked holder may still lock a deposit quote for it: a suspended
 * row re-qualifies against an active quote.
 */
export async function hasExistingTokenTierRow(userId: string, tier: "pro" | "power"): Promise<boolean> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { data, error } = await supabaseAdmin
    .from("token_tier_qualifications")
    .select("id")
    .eq("user_id", userId)
    .eq("tier", tier)
    .limit(1);
  if (error) throw new Error("Failed to read token tier qualifications");
  return Array.isArray(data) && data.length > 0;
}
