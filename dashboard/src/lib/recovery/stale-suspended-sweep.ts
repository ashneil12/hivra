/**
 * Stale-suspended sweeper.
 *
 * Free-tier instances get auto-suspended (lifecycle_state='suspended') by the
 * idle/billing cron when nobody's used them for a while. Their VMs stay parked
 * on the Proxmox host, eating disk on the LVM-thin pool. Without an upper
 * bound, abandoned suspended VMs accumulate forever and eventually starve
 * provisioning.
 *
 * Two timelines based on plan:
 *   - Free plan (plan='free' or no active subscription): aggressive 3-day
 *     warning + 5-day grace = 8 days suspended → deleted. Most of the fleet.
 *   - Other non-paying (formerly-paying users whose subscription canceled or
 *     expired): 30-day warning + 14-day grace = 44 days. They were customers;
 *     give them more rope.
 *   - Paying users (entitlement_state='ok'): never auto-deleted. The
 *     entitlement filter excludes them entirely.
 *
 * Flow:
 *   1. Finds suspended Proxmox rows older than the FREE warn threshold (the
 *      looser one). The per-row check below re-applies the correct threshold
 *      based on resolved plan, so paid-canceled users older than 30 days get
 *      warned but those between 3 and 30 days get skipped.
 *   2. Looks up active subscriptions in batch to classify free vs paid-canceled.
 *   3. Fetches each owner's email from Clerk.
 *   4. Sends a deletion-warning email via Resend.
 *   5. Sets `scheduled_deletion_at = NOW() + <plan>GraceDays` and
 *      `status='scheduled_for_deletion'` so the existing `purge-expired` cron
 *      tears the VM down at the deadline (using the column-aware lifecycle
 *      resolver shipped in the zombie fix — no silent fall-through).
 *
 * Reactivation: when a user resumes a suspended agent, the lifecycle patch
 * helper (`buildInstanceLifecyclePatch`) clears `scheduled_deletion_at` so
 * the deletion is auto-cancelled.
 *
 * Safety guards:
 *   - Skips users with `entitlement_state='ok'` — paying customers are never
 *     auto-deleted, even if their VM happens to be suspended for some reason.
 *   - Hard cap of `STALE_SUSPENDED_MAX_PER_RUN` (default 50) emails per run
 *     so a misconfigured threshold can't drain Resend in one shot.
 *   - Idempotent: each row's email uses a stable Resend idempotencyKey
 *     keyed on instanceId + schedule date, AND the row is filtered out of
 *     subsequent runs because `scheduled_deletion_at` is no longer null.
 *   - Email-first: the DB write only happens after Resend accepts the send,
 *     so a transient email failure leaves the row eligible for retry next day.
 */

import { sendAgentDeletionFinalReminderEmail } from "@/lib/email/agent-deletion-final-reminder";
import { sendAgentDeletionWarningEmail } from "@/lib/email/agent-deletion-warning";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

const DEFAULT_FREE_WARN_DAYS = 3;
const DEFAULT_FREE_GRACE_DAYS = 5;
const DEFAULT_PAID_CANCELED_WARN_DAYS = 30;
const DEFAULT_PAID_CANCELED_GRACE_DAYS = 14;
const DEFAULT_MAX_PER_RUN = 50;
const CLERK_API_BASE_URL = "https://api.clerk.com/v1";
const FREE_PLAN_KEY = "free";

type StaleCandidateRow = {
  id: string;
  user_id: string;
  name: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  last_lifecycle_transition_at: string | null;
  entitlement_state: string | null;
};

type SubscriptionRow = {
  user_id: string;
  plan: string | null;
  status: string | null;
};

type ResolvedPlanTier = "free" | "paid_canceled";

interface ClerkEmailAddress {
  id: string;
  email_address: string;
  verification?: { status?: string } | null;
}

interface ClerkUser {
  id: string;
  first_name?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
}

export interface StaleSuspendedSweepSummary {
  candidates: number;
  warnedAndScheduled: number;
  skippedNotYetEligible: number;
  skippedNoEmail: number;
  emailFailed: number;
  errors: number;
  capHit: boolean;
  byTier: Record<ResolvedPlanTier, number>;
}

export interface StaleSuspendedSweepConfig {
  freeWarnDays: number;
  freeGraceDays: number;
  paidCanceledWarnDays: number;
  paidCanceledGraceDays: number;
  maxPerRun: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveStaleSuspendedConfig(): StaleSuspendedSweepConfig {
  return {
    freeWarnDays: envInt("STALE_SUSPENDED_FREE_WARN_DAYS", DEFAULT_FREE_WARN_DAYS),
    freeGraceDays: envInt("STALE_SUSPENDED_FREE_GRACE_DAYS", DEFAULT_FREE_GRACE_DAYS),
    paidCanceledWarnDays: envInt(
      "STALE_SUSPENDED_PAID_CANCELED_WARN_DAYS",
      DEFAULT_PAID_CANCELED_WARN_DAYS,
    ),
    paidCanceledGraceDays: envInt(
      "STALE_SUSPENDED_PAID_CANCELED_GRACE_DAYS",
      DEFAULT_PAID_CANCELED_GRACE_DAYS,
    ),
    maxPerRun: envInt("STALE_SUSPENDED_MAX_PER_RUN", DEFAULT_MAX_PER_RUN),
  };
}

/**
 * Resolve the plan tier for a user given their (optional) active subscription
 * row. Free-plan users and users without any active subscription both get the
 * tighter timeline. Anyone with a non-free active subscription that's somehow
 * still suspended (canceled or otherwise non-`ok` entitlement) falls into the
 * paid-canceled bucket and gets the longer grace.
 */
export function resolvePlanTier(sub: SubscriptionRow | undefined): ResolvedPlanTier {
  if (!sub) return "free";
  const plan = (sub.plan ?? FREE_PLAN_KEY).toLowerCase();
  return plan === FREE_PLAN_KEY ? "free" : "paid_canceled";
}

function thresholdsFor(
  tier: ResolvedPlanTier,
  config: StaleSuspendedSweepConfig,
): { warnDays: number; graceDays: number } {
  return tier === "free"
    ? { warnDays: config.freeWarnDays, graceDays: config.freeGraceDays }
    : { warnDays: config.paidCanceledWarnDays, graceDays: config.paidCanceledGraceDays };
}

function chooseEmail(user: ClerkUser): string | null {
  const addresses = user.email_addresses || [];
  const primary = addresses.find((a) => a.id === user.primary_email_address_id);
  const verified = addresses.find((a) => a.verification?.status === "verified");
  return (
    primary?.email_address || verified?.email_address || addresses[0]?.email_address || null
  );
}

async function fetchClerkUser(secretKey: string, userId: string): Promise<ClerkUser | null> {
  const response = await fetch(`${CLERK_API_BASE_URL}/users/${userId}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Clerk user fetch failed for ${userId}: ${response.status}`);
  }
  return (await response.json()) as ClerkUser;
}

function formatDeletionDate(deletionAt: Date): string {
  // YYYY-MM-DD UTC — unambiguous for users in any timezone.
  return deletionAt.toISOString().slice(0, 10);
}

export async function runStaleSuspendedSweep(
  config: StaleSuspendedSweepConfig = resolveStaleSuspendedConfig(),
): Promise<StaleSuspendedSweepSummary> {
  const db = supabaseAdmin;
  if (!db) {
    throw new Error("Supabase admin client not configured");
  }
  const clerkSecretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY is not configured");
  }

  // Filter at the LOOSER threshold (whichever plan triggers earliest, almost
  // always free). Per-row we re-apply the correct plan-specific threshold so
  // paid-canceled rows between freeWarnDays and paidCanceledWarnDays get
  // skipped this run.
  const minWarnDays = Math.min(config.freeWarnDays, config.paidCanceledWarnDays);
  const cutoffIso = new Date(Date.now() - minWarnDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from("hermes_instances")
    .select(
      "id, user_id, name, proxmox_node, proxmox_vmid, last_lifecycle_transition_at, entitlement_state",
    )
    .eq("lifecycle_state", "suspended")
    .eq("infrastructure_provider", "proxmox")
    .is("scheduled_deletion_at", null)
    .is("deleted_at", null)
    .lt("last_lifecycle_transition_at", cutoffIso)
    .neq("entitlement_state", "ok")
    .limit(config.maxPerRun + 1) // +1 so we can detect when the cap is the limiter
    .order("last_lifecycle_transition_at", { ascending: true });

  if (error) {
    throw new Error(error.message || "Failed to query stale suspended instances");
  }

  const rows = (data ?? []) as StaleCandidateRow[];
  const capHit = rows.length > config.maxPerRun;
  const candidates = capHit ? rows.slice(0, config.maxPerRun) : rows;

  // Batch-load active subscriptions for the candidate users so we can classify
  // free vs paid-canceled without an N+1 query. Anyone without a row is
  // treated as free (resolvePlanTier).
  const subsByUser = new Map<string, SubscriptionRow>();
  if (candidates.length > 0) {
    const userIds = Array.from(new Set(candidates.map((c) => c.user_id)));
    const { data: subData, error: subErr } = await db
      .from("hermes_subscriptions")
      .select("user_id, plan, status")
      .in("user_id", userIds)
      .eq("status", "active");

    if (subErr) {
      throw new Error(subErr.message || "Failed to load subscriptions for candidates");
    }
    for (const sub of (subData ?? []) as SubscriptionRow[]) {
      // If a user somehow has multiple active rows, the first one wins —
      // doesn't matter which since we only care about plan='free' vs not.
      if (!subsByUser.has(sub.user_id)) subsByUser.set(sub.user_id, sub);
    }
  }

  let warnedAndScheduled = 0;
  let skippedNotYetEligible = 0;
  let skippedNoEmail = 0;
  let emailFailed = 0;
  let errors = 0;
  const byTier: Record<ResolvedPlanTier, number> = { free: 0, paid_canceled: 0 };

  const dayMs = 24 * 60 * 60 * 1000;

  for (const row of candidates) {
    try {
      const tier = resolvePlanTier(subsByUser.get(row.user_id));
      const { warnDays, graceDays } = thresholdsFor(tier, config);

      // Per-row threshold check: a paid-canceled row picked up by the looser
      // SQL filter (e.g. only 5 days suspended) gets deferred until it crosses
      // its actual warn threshold (30 days).
      const lastTransitionAt = row.last_lifecycle_transition_at
        ? new Date(row.last_lifecycle_transition_at).getTime()
        : null;
      if (lastTransitionAt === null || Date.now() - lastTransitionAt < warnDays * dayMs) {
        skippedNotYetEligible += 1;
        continue;
      }

      const clerkUser = await fetchClerkUser(clerkSecretKey, row.user_id);
      if (!clerkUser) {
        skippedNoEmail += 1;
        log.warn("stale-suspended-sweep: clerk user not found", {
          source: "stale-suspended-sweep",
          instanceId: row.id,
          userId: row.user_id,
          tier,
        });
        continue;
      }

      const email = chooseEmail(clerkUser)?.trim().toLowerCase();
      if (!email) {
        skippedNoEmail += 1;
        log.warn("stale-suspended-sweep: clerk user has no email", {
          source: "stale-suspended-sweep",
          instanceId: row.id,
          userId: row.user_id,
          tier,
        });
        continue;
      }

      const now = new Date();
      const deletionAt = new Date(now.getTime() + graceDays * dayMs);
      const deletionDate = formatDeletionDate(deletionAt);

      const sendResult = await sendAgentDeletionWarningEmail({
        email,
        firstName: clerkUser.first_name ?? null,
        deletionDate,
        daysRemaining: graceDays,
        idempotencyKey: `agent-deletion-warning/${row.id}/${deletionDate}`,
      });

      if (!sendResult.sent) {
        emailFailed += 1;
        // Email-first: don't write the schedule if the email never went out.
        // Row stays eligible for retry on the next sweep run.
        continue;
      }

      // Email accepted. Now arm the deletion. Even if this update fails the
      // user got the warning — they'll just see their agent stick around
      // longer than promised, which is a soft failure (not data loss).
      const { error: updateError } = await db
        .from("hermes_instances")
        .update({
          status: "scheduled_for_deletion",
          scheduled_deletion_at: deletionAt.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq("id", row.id)
        .eq("lifecycle_state", "suspended")
        .is("scheduled_deletion_at", null);

      if (updateError) {
        errors += 1;
        log.error(
          "stale-suspended-sweep: failed to mark scheduled_for_deletion after email",
          new Error(updateError.message || "supabase update failed"),
          {
            source: "stale-suspended-sweep",
            instanceId: row.id,
            userId: row.user_id,
            tier,
            failureType: "schedule_write_failed_after_email",
          },
        );
        continue;
      }

      warnedAndScheduled += 1;
      byTier[tier] += 1;
      log.info("stale-suspended-sweep: scheduled instance for deletion", {
        source: "stale-suspended-sweep",
        instanceId: row.id,
        userId: row.user_id,
        proxmoxNode: row.proxmox_node,
        proxmoxVmid: row.proxmox_vmid,
        deletionAt: deletionAt.toISOString(),
        tier,
        graceDays,
      });
    } catch (err) {
      errors += 1;
      log.error("stale-suspended-sweep: candidate processing threw", err, {
        source: "stale-suspended-sweep",
        instanceId: row.id,
        userId: row.user_id,
        failureType: "candidate_processing_threw",
      });
    }
  }

  return {
    candidates: candidates.length,
    warnedAndScheduled,
    skippedNotYetEligible,
    skippedNoEmail,
    emailFailed,
    errors,
    capHit,
    byTier,
  };
}

// ─── Final reminder sweep ──────────────────────────────────────────────
//
// Picks up rows whose deletion is within the next 24 hours and sends a
// one-shot "last chance" email. Idempotency relies on the Resend
// idempotencyKey: same key inside the 24h window dedupes; once the
// deletion fires the row no longer exists for the cron to re-process.

export interface FinalReminderSweepSummary {
  candidates: number;
  reminded: number;
  skippedNoEmail: number;
  emailFailed: number;
  errors: number;
}

type FinalReminderRow = {
  id: string;
  user_id: string;
  scheduled_deletion_at: string;
};

export async function runFinalReminderSweep(): Promise<FinalReminderSweepSummary> {
  const db = supabaseAdmin;
  if (!db) {
    throw new Error("Supabase admin client not configured");
  }
  const clerkSecretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY is not configured");
  }

  const now = Date.now();
  const windowEnd = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date(now).toISOString();

  // status='scheduled_for_deletion' AND scheduled_deletion_at in (now, now+24h]
  const { data, error } = await db
    .from("hermes_instances")
    .select("id, user_id, scheduled_deletion_at")
    .eq("status", "scheduled_for_deletion")
    .gt("scheduled_deletion_at", nowIso)
    .lte("scheduled_deletion_at", windowEnd)
    .is("deleted_at", null);

  if (error) {
    throw new Error(error.message || "Failed to query rows for final reminder");
  }

  const rows = (data ?? []) as FinalReminderRow[];
  let reminded = 0;
  let skippedNoEmail = 0;
  let emailFailed = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const clerkUser = await fetchClerkUser(clerkSecretKey, row.user_id);
      if (!clerkUser) {
        skippedNoEmail += 1;
        continue;
      }
      const email = chooseEmail(clerkUser)?.trim().toLowerCase();
      if (!email) {
        skippedNoEmail += 1;
        continue;
      }

      const deletionAt = new Date(row.scheduled_deletion_at);
      const deletionDate = formatDeletionDate(deletionAt);
      const hoursRemaining = Math.max(
        1,
        Math.round((deletionAt.getTime() - now) / (60 * 60 * 1000)),
      );

      const sendResult = await sendAgentDeletionFinalReminderEmail({
        email,
        firstName: clerkUser.first_name ?? null,
        deletionDate,
        hoursRemaining,
        idempotencyKey: `agent-deletion-final/${row.id}/${deletionDate}`,
      });

      if (!sendResult.sent) {
        emailFailed += 1;
        continue;
      }
      reminded += 1;
      log.info("final-reminder: sent", {
        source: "final-reminder-sweep",
        instanceId: row.id,
        userId: row.user_id,
        deletionAt: row.scheduled_deletion_at,
      });
    } catch (err) {
      errors += 1;
      log.error("final-reminder: candidate processing threw", err, {
        source: "final-reminder-sweep",
        instanceId: row.id,
        userId: row.user_id,
        failureType: "candidate_processing_threw",
      });
    }
  }

  return {
    candidates: rows.length,
    reminded,
    skippedNoEmail,
    emailFailed,
    errors,
  };
}
