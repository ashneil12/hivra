/**
 * Waitlist promotion: when free capacity opens up, invite the next people in
 * the reservation queue with a time-boxed claim window.
 *
 * Self-correcting by design: `promoteNext()` recomputes how many invites the
 * fleet can actually back right now —
 *   available = MAX_FREE_INSTANCES − active_free_instances − outstanding_unexpired_invites
 * — and tops up `invited` rows from the lowest `position` queued reservations to
 * fill it. Callers (the archive cron's capacity-freed hook, the claim-expiry
 * sweep) just call promoteNext(); they don't have to pass a slot count, so a
 * double-call or a missed call only ever converges, never over-invites.
 *
 * No schema migration: the claim window + token live in the existing
 * `reservations.notes` JSONB (`claim_expires_at`, `claim_token`, `invited_at`).
 *
 * Dark-shippable: no-op unless RESERVATION_AUTO_INVITE_ENABLED=true AND
 * MAX_FREE_INSTANCES is a positive number.
 */

import { randomBytes } from "crypto";

import { sendReservationConfirmation } from "@/lib/email/reservation-confirmation";
import { sendReservationInvite } from "@/lib/email/reservation-invite";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "reservations:promote-next";

// Mirrors instance-service's free-tier resource_tier set + non-slot-holding
// lifecycle states. Kept literal here to avoid importing the service graph into
// a cron-reachable helper.
const FREE_TIERS = ["free", "credit_base", "token_base"];
const NON_SLOT_LIFECYCLE = ["deleted", "failed", "cold_archived", "pending_deletion"];

type PromoteResult = {
  ok: boolean;
  enabled: boolean;
  available: number;
  promoted: number;
  reason?: string;
};

function envInt(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function isAutoInviteEnabled(): boolean {
  return process.env.RESERVATION_AUTO_INVITE_ENABLED?.trim().toLowerCase() === "true";
}

export function maxFreeInstances(): number {
  return envInt("MAX_FREE_INSTANCES", 0);
}

export function claimWindowHours(): number {
  const h = envInt("CLAIM_WINDOW_HOURS", 48);
  return h > 0 ? h : 48;
}

/** Count active free instances that hold a host slot (cold_archived excluded). */
export async function countActiveFreeInstances(): Promise<number> {
  const { count, error } = await supabaseAdmin!
    .from("hermes_instances")
    .select("id", { count: "exact", head: true })
    .in("resource_tier", FREE_TIERS)
    .not("lifecycle_state", "in", `(${NON_SLOT_LIFECYCLE.join(",")})`);
  if (error) throw new Error(`countActiveFree failed: ${error.message}`);
  return count ?? 0;
}

type ReservationRow = {
  id: string;
  email: string;
  position: number;
  status: string;
  notes: Record<string, unknown> | null;
};

/** Outstanding invites whose claim window hasn't expired yet. */
async function countOutstandingInvites(nowMs: number): Promise<number> {
  const { data, error } = await supabaseAdmin!
    .from("reservations")
    .select("id, notes")
    .eq("status", "invited")
    .limit(2000);
  if (error) throw new Error(`countOutstandingInvites failed: ${error.message}`);
  let n = 0;
  for (const r of (data ?? []) as Array<{ notes: Record<string, unknown> | null }>) {
    const exp = r.notes?.claim_expires_at as string | undefined;
    // No expiry recorded → treat as outstanding (don't double-invite its slot).
    if (!exp || Date.parse(exp) > nowMs) n += 1;
  }
  return n;
}

/**
 * Top up invites to fill currently-available free capacity. Returns how many
 * fresh invites it sent. Safe to call repeatedly.
 */
export async function promoteNext(): Promise<PromoteResult> {
  if (!supabaseAdmin) return { ok: false, enabled: false, available: 0, promoted: 0, reason: "no_supabase" };
  if (!isAutoInviteEnabled()) return { ok: true, enabled: false, available: 0, promoted: 0, reason: "disabled" };
  const maxFree = maxFreeInstances();
  if (maxFree <= 0) return { ok: true, enabled: false, available: 0, promoted: 0, reason: "no_cap" };

  const nowMs = Date.now();
  let activeFree: number;
  let outstanding: number;
  try {
    [activeFree, outstanding] = await Promise.all([countActiveFreeInstances(), countOutstandingInvites(nowMs)]);
  } catch (e) {
    log.error("promoteNext capacity probe failed", e as Error, { source: LOG_SOURCE });
    return { ok: false, enabled: true, available: 0, promoted: 0, reason: "probe_failed" };
  }

  const available = Math.max(0, maxFree - activeFree - outstanding);
  if (available === 0) {
    return { ok: true, enabled: true, available: 0, promoted: 0, reason: "no_capacity" };
  }

  // Lowest-position queued reservations first (stable FIFO).
  const { data: queued, error: qErr } = await supabaseAdmin
    .from("reservations")
    .select("id, email, position, status, notes")
    .eq("status", "queued")
    .order("position", { ascending: true })
    .limit(available);
  if (qErr) {
    log.error("promoteNext queued fetch failed", qErr, { source: LOG_SOURCE });
    return { ok: false, enabled: true, available, promoted: 0, reason: "queued_fetch_failed" };
  }

  const windowHours = claimWindowHours();
  let promoted = 0;
  for (const row of (queued ?? []) as ReservationRow[]) {
    const token = randomBytes(24).toString("hex");
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + windowHours * 3600_000).toISOString();
    const nextNotes = {
      ...(row.notes ?? {}),
      invited_at: nowIso,
      claim_expires_at: expiresIso,
      claim_token: token,
    };
    // CAS: only flip if still queued (another worker may have taken it).
    const { data: locked, error: lockErr } = await supabaseAdmin
      .from("reservations")
      .update({ status: "invited", notes: nextNotes })
      .eq("id", row.id)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (lockErr) {
      log.error("promoteNext CAS failed", lockErr, { source: LOG_SOURCE, reservationId: row.id });
      continue;
    }
    if (!locked) continue; // raced away

    const res = await sendReservationInvite({
      email: row.email,
      claimToken: token,
      claimWindowHours: windowHours,
    });
    if (!res.sent) {
      // Email failed → revert to queued so a later run retries (don't burn the slot).
      await supabaseAdmin
        .from("reservations")
        .update({ status: "queued", notes: row.notes ?? {} })
        .eq("id", row.id)
        .eq("status", "invited");
      log.warn("promoteNext invite email failed; reverted to queued", {
        source: LOG_SOURCE,
        reservationId: row.id,
        reason: res.reason,
      });
      continue;
    }
    promoted += 1;
  }

  log.info("promoteNext done", {
    source: LOG_SOURCE,
    maxFree,
    activeFree,
    outstanding,
    available,
    promoted,
  });
  return { ok: true, enabled: true, available, promoted };
}

/**
 * Expire stale invites (claim window passed) and re-queue them to the BACK of
 * the line so the slot passes to the next person. Returns count expired.
 * The position bump moves them after current queued rows.
 */
export async function expireStaleInvites(): Promise<{ ok: boolean; expired: number }> {
  if (!supabaseAdmin) return { ok: false, expired: 0 };
  const nowMs = Date.now();
  const { data, error } = await supabaseAdmin
    .from("reservations")
    .select("id, notes, position")
    .eq("status", "invited")
    .limit(2000);
  if (error) {
    log.error("expireStaleInvites fetch failed", error, { source: LOG_SOURCE });
    return { ok: false, expired: 0 };
  }
  const stale = ((data ?? []) as ReservationRow[]).filter((r) => {
    const exp = r.notes?.claim_expires_at as string | undefined;
    return exp && Date.parse(exp) <= nowMs;
  });
  if (stale.length === 0) return { ok: true, expired: 0 };

  // Park them at the back: position = max(position)+1.. so they fall behind
  // everyone currently queued. They get another invite when they reach the front.
  const { data: maxRow } = await supabaseAdmin
    .from("reservations")
    .select("position")
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  let nextPos = ((maxRow?.position as number | undefined) ?? stale[0].position) + 1;

  let expired = 0;
  for (const r of stale) {
    const nextNotes = {
      ...(r.notes ?? {}),
      claim_expired_at: new Date(nowMs).toISOString(),
      missed_invites: ((r.notes?.missed_invites as number | undefined) ?? 0) + 1,
      claim_token: null,
      claim_expires_at: null,
    };
    const { data: updated } = await supabaseAdmin
      .from("reservations")
      .update({ status: "queued", position: nextPos, notes: nextNotes })
      .eq("id", r.id)
      .eq("status", "invited")
      .select("id")
      .maybeSingle();
    if (updated) {
      expired += 1;
      nextPos += 1;
    }
  }
  log.info("expireStaleInvites done", { source: LOG_SOURCE, expired });
  return { ok: true, expired };
}

/**
 * Capture a capped free signup into the waitlist queue so the lead is never
 * lost. Idempotent on email (lower(email) unique). Returns the queue position;
 * sends the confirmation email on a fresh enqueue (best-effort — the row is
 * always recorded even if the email fails). Mirrors POST /api/reserve.
 */
export async function enqueueWaitlist(
  email: string,
  clerkUserId: string | null
): Promise<{ position: number | null; alreadyQueued: boolean }> {
  if (!supabaseAdmin || !email) return { position: null, alreadyQueued: false };

  const { data: existing, error: lookupErr } = await supabaseAdmin
    .from("reservations")
    .select("id, position, clerk_user_id")
    .ilike("email", email)
    .maybeSingle();
  if (lookupErr) {
    log.warn("enqueueWaitlist lookup failed", { source: LOG_SOURCE, error: lookupErr.message });
    return { position: null, alreadyQueued: false };
  }
  if (existing) {
    const row = existing as { id: string; position: number | null; clerk_user_id: string | null };
    if (clerkUserId && !row.clerk_user_id) {
      await supabaseAdmin.from("reservations").update({ clerk_user_id: clerkUserId }).eq("id", row.id);
    }
    return { position: row.position ?? null, alreadyQueued: true };
  }

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("reservations")
    .insert({ email, tier_intent: "free", clerk_user_id: clerkUserId })
    .select("position")
    .single();
  if (insertErr || !inserted) {
    // Race: same email inserted between lookup and insert — re-read the position.
    const { data: race } = await supabaseAdmin
      .from("reservations")
      .select("position")
      .ilike("email", email)
      .maybeSingle();
    return { position: (race as { position: number | null } | null)?.position ?? null, alreadyQueued: true };
  }
  void sendReservationConfirmation({ email }).catch(() => {});
  return { position: (inserted as { position: number | null }).position ?? null, alreadyQueued: false };
}

/**
 * Mark a claimed reservation onboarded so its slot stops counting as an
 * outstanding invite. Matched by email (stable across the signup funnel).
 * Best-effort — called from the create-instance success path.
 */
export async function markReservationOnboardedByEmail(email: string): Promise<void> {
  if (!supabaseAdmin || !email) return;
  try {
    await supabaseAdmin
      .from("reservations")
      .update({ status: "onboarded", notes: { onboarded_at: new Date().toISOString() } })
      .ilike("email", email)
      .in("status", ["invited", "queued"]);
  } catch (e) {
    log.warn("markReservationOnboardedByEmail failed", { source: LOG_SOURCE, error: String(e) });
  }
}
