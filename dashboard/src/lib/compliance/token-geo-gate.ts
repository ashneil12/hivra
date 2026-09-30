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
 * Ops admins (lib/ops-access.ts, OPS_ADMIN_USER_IDS / OPS_ADMIN_EMAILS) are
 * exempt, so the team can test and operate the service from a listed country.
 * The check runs only once a signal would block, and only against server-side
 * identity: the Clerk session's user ID, and the user's verified primary email
 * as Clerk holds it. Nothing in the request can claim it.
 *
 * With an empty policy this module reads nothing: no header, no query, no
 * admin lookup.
 *
 * What it gates is NEW token actions only (quotes, a first tier qualification,
 * a first wallet verification, conversion). Existing tier rows, yearly years,
 * deposit lots, withdrawals, settlement of quotes already issued, and card
 * payments never consult it.
 */
import { log } from "@/lib/logger";
import { isOpsAdminEmailConfigured, isOpsAdminUser } from "@/lib/ops-access";
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
  /** Test seam; defaults to isTokenGeoExemptOpsAdmin. */
  isExemptUser?: (userId: string) => Promise<boolean>;
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

type ClerkUserEmails = {
  primary_email_address_id?: string | null;
  email_addresses?: Array<{
    id?: string | null;
    email_address?: string | null;
    verification?: { status?: string | null } | null;
  }> | null;
};

/**
 * The user's primary email as Clerk holds it, only when Clerk has verified it;
 * otherwise null (none, unverified, no Clerk key, or the read failed). An
 * address the user added but never verified can't make them an ops admin.
 */
export async function readVerifiedPrimaryEmail(userId: string): Promise<string | null> {
  const key = process.env.CLERK_SECRET_KEY?.trim();
  if (!key) return null;
  try {
    const response = await fetch(`${CLERK_API}/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn("token geo: Clerk user read failed; not treating the user as an ops admin", {
        source: LOG_SOURCE,
        userId,
        failureType: "token_geo_admin_email_read_failed",
        status: response.status,
      });
      return null;
    }
    const user = (await response.json()) as ClerkUserEmails | null;
    const primaryId = user?.primary_email_address_id;
    if (!primaryId) return null;
    const primary = (user?.email_addresses ?? []).find((address) => address?.id === primaryId);
    if (primary?.verification?.status !== "verified") return null;
    const email = primary.email_address?.trim();
    return email ? email : null;
  } catch (error) {
    log.warn("token geo: Clerk user read threw; not treating the user as an ops admin", {
      source: LOG_SOURCE,
      userId,
      failureType: "token_geo_admin_email_read_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

/**
 * Whether the user is an ops admin (lib/ops-access.ts `isOpsAdminUser`), and
 * so exempt from the token geo-policy. The user ID is matched first, with no
 * I/O; the verified primary email is read from Clerk only when OPS_ADMIN_EMAILS
 * is set. Any failure answers false, so the block stands.
 */
export async function isTokenGeoExemptOpsAdmin(userId: string): Promise<boolean> {
  if (isOpsAdminUser({ userId })) return true;
  if (!isOpsAdminEmailConfigured()) return false;
  const email = await readVerifiedPrimaryEmail(userId);
  return Boolean(email && isOpsAdminUser({ userId, email }));
}

function blockedDecision(country: string, signal: TokenGeoSignal): TokenGeoDecision {
  return { blocked: true, country, signal, message: tokenGeoNotice(country) };
}

/**
 * Whether a signal that would block this user is waived because they are an
 * ops admin. Called only after a signal would block, never with the dormant
 * policy, and never for a signed-out visitor.
 */
async function isExemptFromBlock(
  userId: string | null | undefined,
  country: string,
  signal: TokenGeoSignal | "session_country",
  options: TokenGeoOptions
): Promise<boolean> {
  if (!userId) return false;
  const exempt = await (options.isExemptUser ?? isTokenGeoExemptOpsAdmin)(userId);
  if (exempt) {
    log.info("token geo: ops admin exempt from a token geo block", {
      source: LOG_SOURCE,
      userId,
      country,
      signal,
      failureType: "token_geo_ops_admin_exempt",
    });
  }
  return exempt;
}

/**
 * Whether this request may start a NEW token action. Blocks when the IP
 * country or the user's stored country is in the policy, unless the user is
 * an ops admin. The empty policy returns "not blocked" before reading anything.
 */
export async function resolveTokenGeoBlock(
  request: TokenGeoRequest,
  user: { userId: string | null | undefined } | null,
  options: TokenGeoOptions = {}
): Promise<TokenGeoDecision> {
  const policy = options.policy ?? TOKEN_GEO_POLICY;
  if (!isTokenGeoPolicyActive(policy)) return TOKEN_GEO_NOT_BLOCKED;

  const userId = user?.userId;
  let decision: TokenGeoDecision = TOKEN_GEO_NOT_BLOCKED;
  const ipCountry = readIpCountry(request);
  if (ipCountry && isCountryBlockedForTokens(ipCountry, policy)) {
    decision = blockedDecision(ipCountry, "ip_country");
  } else if (userId) {
    const stored = await (options.readStoredCountry ?? readStoredTokenCountry)(userId);
    if (stored && isCountryBlockedForTokens(stored, policy)) {
      decision = blockedDecision(stored, "stored_country");
    }
  }

  if (decision.blocked && (await isExemptFromBlock(userId, decision.country, decision.signal, options))) {
    return TOKEN_GEO_NOT_BLOCKED;
  }
  return decision;
}

/**
 * Whether a NEW token-tier qualification row may be recorded. Existing rows
 * are never passed here. A caller that resolved a request passes its decision
 * (IP + stored, with the ops-admin exemption already applied). Without one
 * (crons, and routes that don't pass it) the stored country and Clerk's
 * latest-session country decide, and an ops admin is exempt.
 */
export async function isNewTokenQualificationRefused(
  userId: string,
  decision?: TokenGeoDecision,
  options: TokenGeoOptions = {}
): Promise<boolean> {
  const policy = options.policy ?? TOKEN_GEO_POLICY;
  if (!isTokenGeoPolicyActive(policy)) return false;
  if (decision) return decision.blocked;

  let blockedBy: { country: string; signal: TokenGeoSignal | "session_country" } | null = null;
  const stored = await (options.readStoredCountry ?? readStoredTokenCountry)(userId);
  if (stored && isCountryBlockedForTokens(stored, policy)) {
    blockedBy = { country: stored, signal: "stored_country" };
  } else {
    const session = await (options.readSessionCountry ?? readLatestSessionCountry)(userId);
    if (session && isCountryBlockedForTokens(session, policy)) {
      blockedBy = { country: session, signal: "session_country" };
    }
  }
  if (!blockedBy) return false;
  return !(await isExemptFromBlock(userId, blockedBy.country, blockedBy.signal, options));
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
