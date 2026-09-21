import { NextRequest, after } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { sendReservationConfirmation } from "@/lib/email/reservation-confirmation";
import { syncReservationToAnnouncementAudience } from "@/lib/email/resend-announcement-sync";
import { log } from "@/lib/logger";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TIER_INTENTS = ["free", "pro", "power"] as const;
type TierIntent = (typeof TIER_INTENTS)[number];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

interface ReservationRow {
  id: string;
  email: string;
  tier_intent: TierIntent;
  position: number;
  status: "queued" | "invited" | "onboarded" | "cancelled";
  clerk_user_id: string | null;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_EMAIL_LENGTH) return null;
  if (!EMAIL_REGEX.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function normalizeTierIntent(value: unknown): TierIntent | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  return (TIER_INTENTS as readonly string[]).includes(lowered)
    ? (lowered as TierIntent)
    : null;
}

async function getOptionalClerkUserId(): Promise<string | null> {
  try {
    const { userId } = await auth();
    return userId ?? null;
  } catch {
    // Public route — auth() must never block reservation creation.
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return apiError("Reservation service is not configured", 503, {
      failureType: "reservation_db_not_configured",
    });
  }

  // Per-IP rate limit. Reservation creation is low-frequency for legit
  // users (1-2 lifetime submissions), so a tight bucket is fine and
  // makes the endpoint a poor enumeration tool — without this, a bot
  // could probe arbitrary emails one row at a time and read back the
  // `already_existed` / `tier_intent` fields.
  const ip = getIP(req);
  const rate = enforceRateLimit(`reserve:${ip}`, { limit: 5, windowMs: 10 * 60_000 });
  if (!rate.success) {
    return apiError("Too many reservation attempts. Please wait and try again.", 429, {
      failureType: "reservation_rate_limited",
    });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return apiError("Invalid JSON body", 400, {
      failureType: "reservation_invalid_json",
    });
  }

  if (!payload || typeof payload !== "object") {
    return apiError("Request body must be a JSON object", 400, {
      failureType: "reservation_invalid_body",
    });
  }

  const body = payload as Record<string, unknown>;
  const email = normalizeEmail(body.email);
  if (!email) {
    return apiError("A valid email address is required", 400, {
      failureType: "reservation_invalid_email",
    });
  }

  const tierIntent = normalizeTierIntent(body.tier_intent);
  if (!tierIntent) {
    return apiError("tier_intent must be one of free, pro, or power", 400, {
      failureType: "reservation_invalid_tier_intent",
    });
  }

  const clerkUserId = await getOptionalClerkUserId();

  try {
    const { data: existing, error: lookupError } = await supabaseAdmin
      .from("reservations")
      .select("id, email, tier_intent, position, status, clerk_user_id")
      .ilike("email", email)
      .maybeSingle<ReservationRow>();

    if (lookupError) {
      return apiError("Failed to record reservation", 500, {
        failureType: "reservation_lookup_failed",
        errorName: lookupError.code || "supabase_error",
      });
    }

    if (existing) {
      // Backfill clerk_user_id if the visitor is now signed in and we
      // didn't have one before. Don't change anything else — the queue
      // position must stay stable.
      if (clerkUserId && !existing.clerk_user_id) {
        await supabaseAdmin
          .from("reservations")
          .update({ clerk_user_id: clerkUserId })
          .eq("id", existing.id);
      }

      return apiSuccess({
        position: existing.position,
        tier_intent: existing.tier_intent,
        status: existing.status,
        already_existed: true,
      });
    }

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("reservations")
      .insert({
        email,
        tier_intent: tierIntent,
        clerk_user_id: clerkUserId,
      })
      .select("position, tier_intent, status")
      .single<Pick<ReservationRow, "position" | "tier_intent" | "status">>();

    if (insertError || !inserted) {
      // Race: another request inserted the same email between our lookup
      // and insert. Fall back to a fresh lookup so the caller still gets
      // the canonical position.
      const { data: raceRow } = await supabaseAdmin
        .from("reservations")
        .select("position, tier_intent, status")
        .ilike("email", email)
        .maybeSingle<Pick<ReservationRow, "position" | "tier_intent" | "status">>();

      if (raceRow) {
        return apiSuccess({
          position: raceRow.position,
          tier_intent: raceRow.tier_intent,
          status: raceRow.status,
          already_existed: true,
        });
      }

      return apiError("Failed to record reservation", 500, {
        failureType: "reservation_insert_failed",
        errorName: insertError?.code || "supabase_error",
      });
    }

    // Best-effort confirmation email. The helper catches its own errors
    // and returns a result object — we await it so it actually runs in
    // the serverless function instance, but we never gate the response
    // on the email outcome.
    await sendReservationConfirmation({ email });

    // Best-effort audience sync. Runs after the response is sent so the
    // user never waits on Resend's contact API. Any failure (including
    // `after` not being available outside of Next's request scope, e.g.
    // in unit tests) is logged and swallowed — the reservation already
    // succeeded, the audience is a downstream concern.
    try {
      after(async () => {
        try {
          await syncReservationToAnnouncementAudience(email);
        } catch (err) {
          log.warn("reservation audience sync failed", {
            source: "reserve-route",
            failureType: "reservation_audience_sync_failed",
            errorName: err instanceof Error ? err.name : typeof err,
          });
        }
      });
    } catch (err) {
      log.warn("reservation audience sync skipped", {
        source: "reserve-route",
        failureType: "reservation_audience_sync_after_unavailable",
        errorName: err instanceof Error ? err.name : typeof err,
      });
    }

    return apiSuccess(
      {
        position: inserted.position,
        tier_intent: inserted.tier_intent,
        status: inserted.status,
        already_existed: false,
      },
      201
    );
  } catch (error) {
    return apiError("Failed to record reservation", 500, {
      failureType: "reservation_unexpected_error",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

export async function GET() {
  if (!supabaseAdmin) {
    return apiError("Reservation service is not configured", 503, {
      failureType: "reservation_db_not_configured",
    });
  }

  // Auth-gated lookup. The previous version accepted any email as a
  // query param, which let anyone on the internet enumerate the
  // reservation queue (`?email=victim@example.com` → `found: true`,
  // tier_intent disclosed). The lookup is now scoped to the caller's
  // own Clerk user id so a returning *signed-in* visitor still gets a
  // "you're at position N" UX and unauthenticated callers get nothing.
  const { userId } = await auth();
  if (!userId) {
    return apiError("Sign in to look up your reservation.", 401, {
      failureType: "reservation_lookup_unauthenticated",
    });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("reservations")
      .select("position, tier_intent, status")
      .eq("clerk_user_id", userId)
      .maybeSingle<Pick<ReservationRow, "position" | "tier_intent" | "status">>();

    if (error) {
      return apiError("Failed to look up reservation", 500, {
        failureType: "reservation_lookup_failed",
        errorName: error.code || "supabase_error",
      });
    }

    if (!data) {
      return apiSuccess({ found: false });
    }

    return apiSuccess({
      found: true,
      position: data.position,
      tier_intent: data.tier_intent,
      status: data.status,
    });
  } catch (error) {
    return apiError("Failed to look up reservation", 500, {
      failureType: "reservation_lookup_unexpected_error",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
