import "server-only";

// Invite & Earn referral program (paioclaw rip-list).
//
// Server-only. Everything goes through supabaseAdmin (service role), mirroring
// lib/account-memory.ts. Identity is the Clerk user_id string (there is NO
// public.users table). Reads NEVER throw — a missing table, missing client, or a
// query error all degrade to a safe empty value, so the app stays 100% healthy on
// canary with the feature flag OFF and the migration UNAPPLIED.
//
// Two tables (see migration 20260619120000_referral_program.sql):
//   referral_codes        — one stable code per user; the share link is derived.
//   referral_attributions — one row per referee (who referred them, status).
//
// Reward grants reuse the credit ledger: appendCreditLedgerEntry(reason:
// "bonus_credit") with a referral-scoped, idempotent reference_id, so a double
// callback can never double-pay (23505 conflict is swallowed by the ledger).

import { supabaseAdmin } from "@/lib/supabase";
import { appendCreditLedgerEntry } from "@/lib/billing/credits";

// ---------------------------------------------------------------------------
// Owner-tunable constants. Change these to retune the program economics.
// ---------------------------------------------------------------------------

/** Credits granted to the REFERRER when one of their referees activates. 100 credits = $1, so 500 = $5. */
const REFERRAL_REWARD_CREDITS_REFERRER = 500;
/** Credits granted to the REFEREE when they activate. 100 credits = $1, so 500 = $5. */
const REFERRAL_REWARD_CREDITS_REFEREE = 500;
/** Max number of referrals a single referrer can ever be REWARDED for. */
const REFERRAL_MAX_REWARDED_PER_REFERRER = 20;
/** Length of the generated share code (uppercase base32-ish, ambiguous chars removed). */
const REFERRAL_CODE_LENGTH = 8;

// ---------------------------------------------------------------------------
// Feature flag. OFF unless explicitly enabled. Same string on client + server
// (NEXT_PUBLIC_* is readable in both). Read through a computed key so a
// server-side caller resolves the LIVE runtime value rather than a build-inlined
// freeze (see lib/venice/managed-endpoints.ts for why this matters).
// ---------------------------------------------------------------------------

const REFERRAL_FLAG_ENV = "NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED";

export function isReferralEnabled(): boolean {
  const key = REFERRAL_FLAG_ENV;
  return process.env[key] === "true";
}

// ---------------------------------------------------------------------------
// Code generation + link building.
// ---------------------------------------------------------------------------

// Crockford-ish alphabet: no 0/O/1/I/L to keep hand-typed codes unambiguous.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function randomCode(len = REFERRAL_CODE_LENGTH): string {
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

const DEFAULT_APP_URL = "https://hivra.cloud";

function runtimeAppUrl(): string | undefined {
  // Computed-key read so server callers see the live runtime apex, not a
  // build-time inlined value (mirrors lib/venice/managed-endpoints.ts).
  const key = "NEXT_PUBLIC_APP_URL";
  return process.env[key];
}

/** Build the public invite link for a code. e.g. https://hivra.cloud/?ref=ABCD2345 */
function buildReferralLink(code: string): string {
  const base = (runtimeAppUrl()?.trim() || DEFAULT_APP_URL).replace(/\/+$/, "");
  return `${base}/?ref=${encodeURIComponent(code)}`;
}

// ---------------------------------------------------------------------------
// Code fetch/create — idempotent per user.
// ---------------------------------------------------------------------------

/**
 * The user's stable referral code, creating one on first call. Returns null if
 * the feature is off, the DB client is missing, or the table doesn't exist yet
 * (degrades silently so the UI shows an empty state instead of erroring).
 */
async function ensureReferralCode(userId: string): Promise<string | null> {
  if (!isReferralEnabled() || !supabaseAdmin || !userId) return null;
  try {
    const existing = await supabaseAdmin
      .from("referral_codes")
      .select("code")
      .eq("user_id", userId)
      .maybeSingle();
    if (existing.data?.code && typeof existing.data.code === "string") {
      return existing.data.code;
    }

    // Create one, retrying on the rare code collision (unique constraint).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomCode();
      const { error } = await supabaseAdmin
        .from("referral_codes")
        .insert({ user_id: userId, code });
      if (!error) return code;
      // 23505: either user_id already has a row (race) or code collided.
      if (error.code === "23505") {
        const reread = await supabaseAdmin
          .from("referral_codes")
          .select("code")
          .eq("user_id", userId)
          .maybeSingle();
        if (reread.data?.code && typeof reread.data.code === "string") {
          return reread.data.code;
        }
        // code collision (not user_id) — loop and try a fresh code.
        continue;
      }
      // Unknown error (e.g. missing table) — degrade to null.
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Look up the referrer user_id that owns a code, or null. Never throws. */
async function resolveReferrerByCode(code: string): Promise<string | null> {
  if (!supabaseAdmin || !code) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("referral_codes")
      .select("user_id")
      .eq("code", code)
      .maybeSingle();
    if (error || !data?.user_id) return null;
    return typeof data.user_id === "string" ? data.user_id : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Attribution — recorded at Clerk user.created.
// ---------------------------------------------------------------------------

/**
 * Record that `refereeUserId` signed up via `code`. Idempotent (unique on
 * referee_user_id) and self-referral-safe. Never throws — any failure (feature
 * off, missing table, unknown/own code, already attributed) is a silent no-op so
 * the signup critical path is never affected.
 */
export async function recordReferralAttribution(
  refereeUserId: string,
  code: string | null | undefined,
): Promise<{ recorded: boolean; referrerUserId: string | null }> {
  const noop = { recorded: false, referrerUserId: null };
  if (!isReferralEnabled() || !supabaseAdmin || !refereeUserId) return noop;
  const trimmed = (code || "").trim().toUpperCase();
  if (!trimmed) return noop;
  try {
    const referrerUserId = await resolveReferrerByCode(trimmed);
    if (!referrerUserId || referrerUserId === refereeUserId) return noop;

    const { error } = await supabaseAdmin.from("referral_attributions").insert({
      referee_user_id: refereeUserId,
      referrer_user_id: referrerUserId,
      code: trimmed,
      status: "pending",
    });
    // 23505 = this referee was already attributed; treat as a no-op success.
    if (error && error.code !== "23505") return noop;
    return { recorded: true, referrerUserId };
  } catch {
    return noop;
  }
}

// ---------------------------------------------------------------------------
// Reward — granted when a referee activates/converts.
// ---------------------------------------------------------------------------

type ReferralRewardResult =
  | { rewarded: false; reason: string }
  | { rewarded: true; referrerUserId: string };

// ---------------------------------------------------------------------------
// Stats — for the Invite & Earn UI.
// ---------------------------------------------------------------------------

export interface ReferralSummary {
  enabled: boolean;
  code: string | null;
  link: string | null;
  rewardedCount: number;
  pendingCount: number;
  rewardCreditsPerReferral: number;
  maxRewardedReferrals: number;
}

/**
 * Everything the Invite & Earn card needs. Always returns a well-formed object;
 * degrades to an empty/disabled summary on any failure so the card can render a
 * safe empty state with the flag off or the migration unapplied.
 */
export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const base: ReferralSummary = {
    enabled: isReferralEnabled(),
    code: null,
    link: null,
    rewardedCount: 0,
    pendingCount: 0,
    rewardCreditsPerReferral: REFERRAL_REWARD_CREDITS_REFERRER,
    maxRewardedReferrals: REFERRAL_MAX_REWARDED_PER_REFERRER,
  };
  if (!base.enabled || !supabaseAdmin || !userId) return base;

  try {
    const code = await ensureReferralCode(userId);
    const link = code ? buildReferralLink(code) : null;

    let rewardedCount = 0;
    let pendingCount = 0;
    try {
      const rewarded = await supabaseAdmin
        .from("referral_attributions")
        .select("id", { count: "exact", head: true })
        .eq("referrer_user_id", userId)
        .eq("status", "rewarded");
      rewardedCount = rewarded.count ?? 0;

      const pending = await supabaseAdmin
        .from("referral_attributions")
        .select("id", { count: "exact", head: true })
        .eq("referrer_user_id", userId)
        .eq("status", "pending");
      pendingCount = pending.count ?? 0;
    } catch {
      // Missing table / query error — leave counts at 0.
    }

    return { ...base, code, link, rewardedCount, pendingCount };
  } catch {
    return base;
  }
}
