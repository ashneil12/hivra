/**
 * Warm-pool campaign sweep — STAGED, owner-triggered, double-gated.
 *
 * One-shot Pro pitch to the engaged-free pool: free plan + a running
 * (lifecycle_state 'active') instance + activity within the last 7 days
 * (the exact fetchEngagedFreeUserIds definition the insights funnel uses).
 * Driven by POST /api/admin/warm-pool-campaign; the email itself lives in
 * email/warm-pool-campaign.ts.
 *
 * NOTHING SENDS BY DEFAULT. Two independent gates:
 *   1. dryRun defaults TRUE — callers must pass dryRun:false explicitly.
 *      Dry runs never touch Clerk, Resend, or PostHog; they only count the
 *      cohort and preview the first 20 user ids + the rendered subject.
 *   2. WARM_POOL_CAMPAIGN_ENABLED (env, default false) — even dryRun:false
 *      is inert until the env flips. A blocked real send reports exactly
 *      which gate stopped it via `blockedBy`.
 *
 * Real-send guarantees (mirrors the lifecycle sweep):
 *   - EXCLUDES anyone already in lifecycle_email_sends with email_key
 *     'day7_offer' (they got the lifecycle Pro pitch) or WARM_POOL_EMAIL_KEY
 *     (this campaign already reached them — reruns are safe).
 *   - At most one send per user EVER: ledger row (email_key
 *     WARM_POOL_EMAIL_KEY) written after Resend accepts, plus the stable
 *     Resend idempotencyKey `warm_pool_2026_06_<user_id>` as the second
 *     line of defense.
 *   - Hard cap WARM_POOL_HARD_CAP (300) per run, on top of the optional
 *     caller `limit`.
 *   - Per-send try/catch: one bad row never kills the run.
 *   - Recipient resolution = the lifecycle sweep's Clerk mechanism
 *     (resolveClerkRecipient).
 *   - PostHog `warm_pool_email_sent` capture per send, flushed before the
 *     function returns.
 */

import "server-only";
import { chunk } from "@/lib/array-utils";

import {
  ENGAGED_POOL_ACTIVITY_DAYS,
  fetchEngagedFreeUserIds,
} from "@/lib/conversion-funnel";
import {
  WARM_POOL_EMAIL_KEY,
  buildWarmPoolEmail,
  sendWarmPoolEmail,
} from "@/lib/email/warm-pool-campaign";
import { resolveClerkRecipient } from "@/lib/recovery/lifecycle-email-sweep";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "warm-pool-campaign-sweep";

const DAY_MS = 86_400_000;
const QUERY_LIMIT = 1000;
const IN_CHUNK_SIZE = 200;
const SAMPLE_SIZE = 20;

/** Absolute per-run send ceiling, regardless of the caller's `limit`. */
export const WARM_POOL_HARD_CAP = 300;

/**
 * Users with any of these ledger keys are excluded: day7_offer already
 * pitched them Pro via the lifecycle track, WARM_POOL_EMAIL_KEY means this
 * campaign already reached them.
 */
const WARM_POOL_EXCLUDED_EMAIL_KEYS = ["day7_offer", WARM_POOL_EMAIL_KEY] as const;

export function isWarmPoolCampaignEnabled(): boolean {
  const v = process.env.WARM_POOL_CAMPAIGN_ENABLED?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export interface WarmPoolPlan {
  /** Engaged-free pool size before exclusions. */
  cohortSize: number;
  /** Dropped because lifecycle_email_sends already has day7_offer / this campaign. */
  excludedAlreadyEmailed: number;
  /** Cohort minus exclusions. */
  eligible: number;
  /** The user ids a real send would mail (after limit + hard cap), in order. */
  planned: string[];
  /** True when limit / hard cap truncated the eligible list. */
  capHit: boolean;
}

/** Pure planning step: exclusions, then optional limit, then the hard cap. */
export function planWarmPoolSends(input: {
  engagedUserIds: string[];
  alreadyEmailedUserIds: ReadonlySet<string>;
  limit?: number;
}): WarmPoolPlan {
  const eligibleIds = input.engagedUserIds.filter(
    (id) => !input.alreadyEmailedUserIds.has(id)
  );
  const requested =
    typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
      ? Math.floor(input.limit)
      : Number.POSITIVE_INFINITY;
  const cap = Math.min(requested, WARM_POOL_HARD_CAP);
  const planned = eligibleIds.slice(0, cap);
  return {
    cohortSize: input.engagedUserIds.length,
    excludedAlreadyEmailed: input.engagedUserIds.length - eligibleIds.length,
    eligible: eligibleIds.length,
    planned,
    capHit: planned.length < eligibleIds.length,
  };
}

export interface WarmPoolCampaignSummary {
  dryRun: boolean;
  /** Current state of the WARM_POOL_CAMPAIGN_ENABLED env gate. */
  enabled: boolean;
  /** Set when a real send was requested but a gate stopped it. */
  blockedBy: "WARM_POOL_CAMPAIGN_ENABLED" | null;
  cohortSize: number;
  excludedAlreadyEmailed: number;
  eligible: number;
  plannedSends: number;
  capHit: boolean;
  /** First 20 planned user ids — the dry-run preview. */
  sampleUserIds: string[];
  /** The rendered subject line, so the owner reviews exactly what goes out. */
  subject: string;
  sent: number;
  failed: number;
  skippedNoEmail: number;
}

export async function runWarmPoolCampaign(opts: {
  dryRun: boolean;
  limit?: number;
  now?: Date;
}): Promise<WarmPoolCampaignSummary> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const db = supabaseAdmin;

  const now = opts.now ?? new Date();
  const cutoffIso = new Date(
    now.getTime() - ENGAGED_POOL_ACTIVITY_DAYS * DAY_MS
  ).toISOString();

  // 1. Cohort: the same engaged-free pool the insights funnel reports.
  const engagedUserIds = await fetchEngagedFreeUserIds(db, cutoffIso);

  // 2. Exclusions from the lifecycle_email_sends ledger.
  const alreadyEmailed = new Set<string>();
  for (const ids of chunk(engagedUserIds, IN_CHUNK_SIZE)) {
    const { data, error } = await db
      .from("lifecycle_email_sends")
      .select("user_id")
      .in("user_id", ids)
      .in("email_key", [...WARM_POOL_EXCLUDED_EMAIL_KEYS])
      .limit(QUERY_LIMIT);
    if (error) {
      throw new Error(
        `warm-pool exclusion query failed: ${error.message || "query failed"}`
      );
    }
    for (const row of (data ?? []) as Array<{ user_id: string }>) {
      alreadyEmailed.add(row.user_id);
    }
  }

  const plan = planWarmPoolSends({
    engagedUserIds,
    alreadyEmailedUserIds: alreadyEmailed,
    limit: opts.limit,
  });

  const summary: WarmPoolCampaignSummary = {
    dryRun: opts.dryRun,
    enabled: isWarmPoolCampaignEnabled(),
    blockedBy: null,
    cohortSize: plan.cohortSize,
    excludedAlreadyEmailed: plan.excludedAlreadyEmailed,
    eligible: plan.eligible,
    plannedSends: plan.planned.length,
    capHit: plan.capHit,
    sampleUserIds: plan.planned.slice(0, SAMPLE_SIZE),
    subject: buildWarmPoolEmail({}).subject,
    sent: 0,
    failed: 0,
    skippedNoEmail: 0,
  };

  // Gate 1: dry run — count and preview only. No Clerk, no Resend, no PostHog.
  if (opts.dryRun) return summary;

  // Gate 2: the env switch. Even an explicit dryRun:false is inert until
  // WARM_POOL_CAMPAIGN_ENABLED=true is set in the deployment env.
  if (!summary.enabled) {
    summary.blockedBy = "WARM_POOL_CAMPAIGN_ENABLED";
    log.info("warm-pool campaign real send blocked by env gate", {
      source: LOG_SOURCE,
      plannedSends: summary.plannedSends,
    });
    return summary;
  }

  const clerkSecret = process.env.CLERK_SECRET_KEY?.trim();

  let captured = 0;
  for (const userId of plan.planned) {
    try {
      if (!clerkSecret) {
        summary.skippedNoEmail += 1;
        continue;
      }
      const recipient = await resolveClerkRecipient(clerkSecret, userId);
      if (!recipient) {
        summary.skippedNoEmail += 1;
        continue;
      }

      const res = await sendWarmPoolEmail({
        email: recipient.email,
        firstName: recipient.firstName,
        idempotencyKey: `${WARM_POOL_EMAIL_KEY}_${userId}`,
      });
      if (!res.sent) {
        summary.failed += 1;
        continue;
      }

      // Ledger write AFTER Resend accepts. If this fails the Resend
      // idempotencyKey still dedupes the retry, so count it failed (not
      // clean) and move on.
      const { error: insertErr } = await db
        .from("lifecycle_email_sends")
        .upsert(
          { user_id: userId, email_key: WARM_POOL_EMAIL_KEY },
          { onConflict: "user_id,email_key", ignoreDuplicates: true }
        );
      if (insertErr) {
        summary.failed += 1;
        log.warn("warm-pool email sent but ledger insert failed", {
          source: LOG_SOURCE,
          userId,
          errorMessage: insertErr.message,
        });
        continue;
      }

      summary.sent += 1;
      posthogClient.capture({
        distinctId: userId,
        event: "warm_pool_email_sent",
        properties: {
          email_key: WARM_POOL_EMAIL_KEY,
          $insert_id: `warm_pool_email_sent_${userId}`,
        },
      });
      captured += 1;
    } catch (err) {
      summary.failed += 1;
      log.warn("warm-pool email send failed", {
        source: LOG_SOURCE,
        userId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Flush before the function dies — Vercel won't wait for async flushes.
  if (captured > 0) {
    try {
      await posthogClient.flush();
    } catch (err) {
      log.warn("posthog flush failed", {
        source: LOG_SOURCE,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
