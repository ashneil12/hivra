/**
 * First-win email sweep.
 *
 * Hourly selection + send for two one-time nudges toward a user's first win
 * (the first message sent to an agent). Driven by /api/cron/first-win-emails,
 * gated by HIVRA_FIRST_WIN_EMAILS_ENABLED (off by default).
 *
 *   first_win_launch   signup 24h to 7d ago and no agent ever launched
 *                      (either lane, deleted rows included).
 *   first_win_say_hi   an agent became ready 1h to 7d ago and the user has
 *                      not sent a message to any agent.
 *
 * Guarantees:
 *   - At most one send per (user, key) ever, through the shared
 *     lifecycle_email_sends ledger (checked before, written after Resend
 *     accepts) plus a stable Resend idempotency key.
 *   - Never after the step is done: launch needs zero agents ever, say-hi
 *     needs zero first_usage_at stamps across the user's agents.
 *   - A user who already got the older day1_idle email is not sent
 *     first_win_launch (same message, same moment).
 *   - One email per user per run (the two never overlap anyway: say-hi needs
 *     an agent, launch needs none).
 *   - Per-send try/catch and a batch cap (HIVRA_FIRST_WIN_EMAILS_BATCH_SIZE,
 *     default 50). The 7 day lookback stops the first enabled run from mailing
 *     the whole historical fleet.
 *   - Unverified Clerk addresses are never mailed (shared recipient logic).
 *
 * Funnel events (PostHog, no personal data), each sent once by existing code:
 *   signup_completed (client, PostHogProvider), box_created (first agent
 *   launched, server), activation_instance_ready (first agent ready, server),
 *   agent_first_message_sent (first message sent). Each email send also
 *   records lifecycle_email_sent with the email_key.
 */

import "server-only";
import { chunk } from "@/lib/array-utils";

import { isPaidPlan } from "@/lib/conversion-funnel";
import {
  sendFirstWinEmail,
  type FirstWinEmailKey,
  type FirstWinLaunchProfile,
} from "@/lib/email/first-win";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import { resolveClerkRecipient, withinHoursAgo } from "@/lib/recovery/lifecycle-email-sweep";
import { SITE_URL } from "@/lib/seo-urls";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "first-win-email-sweep";
const HOUR_MS = 3_600_000;
const QUERY_LIMIT = 1000;
const IN_CHUNK_SIZE = 200;
const DEFAULT_BATCH_SIZE = 50;
const LOOKBACK_HOURS = 7 * 24;
const LAUNCH_MIN_HOURS = 24;
const SAY_HI_MIN_HOURS = 1;
const LEGACY_IDLE_KEY = "day1_idle";

export interface FirstWinSubscription {
  user_id: string;
  plan: string | null;
  created_at: string;
}

/** One agent, from either lane, as the say-hi selection sees it. */
export interface FirstWinAgent {
  id: string;
  lane: "hivra" | "hermes";
  name: string | null;
  /** When it became ready (hivra provisioned_at, hermes first_active_at). */
  readyAt: string | null;
  firstUsageAt: string | null;
}

export interface FirstWinLaunchPick {
  profile: FirstWinLaunchProfile;
  paid: boolean;
}

/** Pure: is this account due the "launch your first agent" email? */
export function selectLaunchNudge(input: {
  subscription: FirstWinSubscription | null;
  everLaunched: boolean;
  sentKeys: ReadonlySet<string>;
  now: Date;
}): FirstWinLaunchPick | null {
  const { subscription, everLaunched, sentKeys, now } = input;
  if (!subscription || everLaunched) return null;
  if (sentKeys.has("first_win_launch") || sentKeys.has(LEGACY_IDLE_KEY)) return null;
  if (!withinHoursAgo(subscription.created_at, now, LAUNCH_MIN_HOURS, LOOKBACK_HOURS)) return null;
  const paid = isPaidPlan(subscription.plan);
  return { profile: paid ? "hermes" : "claude-code", paid };
}

/** Pure: the agent to point a "say hi" email at, or null when none is due. */
export function selectSayHiNudge(input: {
  agents: FirstWinAgent[];
  sentKeys: ReadonlySet<string>;
  now: Date;
}): FirstWinAgent | null {
  const { agents, sentKeys, now } = input;
  if (sentKeys.has("first_win_say_hi")) return null;
  // The step is done once any agent has had a message.
  if (agents.some((a) => a.firstUsageAt)) return null;
  const due = agents
    .filter((a) => a.readyAt && withinHoursAgo(a.readyAt, now, SAY_HI_MIN_HOURS, LOOKBACK_HOURS))
    .sort((a, b) => Date.parse(a.readyAt as string) - Date.parse(b.readyAt as string));
  return due[0] ?? null;
}

export function agentPageUrl(agent: Pick<FirstWinAgent, "id" | "lane">): string {
  return agent.lane === "hivra"
    ? `${SITE_URL}/dashboard/agent/${agent.id}`
    : `${SITE_URL}/dashboard/instances/${agent.id}`;
}

export interface FirstWinSweepSummary {
  candidates: number;
  first_win_launch: number;
  first_win_say_hi: number;
  skipped_no_email: number;
  failed: number;
  capHit: boolean;
}

function batchSize(): number {
  const parsed = Number.parseInt(process.env.HIVRA_FIRST_WIN_EMAILS_BATCH_SIZE?.trim() ?? "", 10);
  return Math.min(500, Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_SIZE);
}

function throwOnError(label: string, error: { message?: string | null } | null): void {
  if (error) throw new Error(`${label}: ${error.message || "query failed"}`);
}

type Planned =
  | { userId: string; key: "first_win_launch"; pick: FirstWinLaunchPick }
  | { userId: string; key: "first_win_say_hi"; agent: FirstWinAgent };

export async function runFirstWinEmailSweep(opts?: { now?: Date; batchSize?: number }): Promise<FirstWinSweepSummary> {
  const summary: FirstWinSweepSummary = {
    candidates: 0,
    first_win_launch: 0,
    first_win_say_hi: 0,
    skipped_no_email: 0,
    failed: 0,
    capHit: false,
  };
  if (!supabaseAdmin) throw new Error("Database not configured");
  const db = supabaseAdmin;
  const now = opts?.now ?? new Date();
  const cap = Math.max(1, opts?.batchSize ?? batchSize());
  const clerkSecret = process.env.CLERK_SECRET_KEY?.trim();
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  // 1. Candidate pools: recent signups, and agents that became ready recently.
  const { data: subRows, error: subErr } = await db
    .from("hermes_subscriptions")
    .select("user_id, plan, created_at")
    .gte("created_at", iso(LOOKBACK_HOURS * HOUR_MS))
    .lte("created_at", iso(LAUNCH_MIN_HOURS * HOUR_MS))
    .limit(QUERY_LIMIT);
  throwOnError("first-win subscription query failed", subErr);
  const subByUser = new Map(((subRows ?? []) as FirstWinSubscription[]).map((s) => [s.user_id, s]));

  const { data: hivraReady, error: hivraErr } = await db
    .from("hivra_agents")
    .select("user_id")
    .eq("status", "running")
    .gte("provisioned_at", iso(LOOKBACK_HOURS * HOUR_MS))
    .lte("provisioned_at", iso(SAY_HI_MIN_HOURS * HOUR_MS))
    .is("first_usage_at", null)
    .limit(QUERY_LIMIT);
  throwOnError("first-win hivra ready query failed", hivraErr);

  const { data: hermesReady, error: hermesErr } = await db
    .from("hermes_instances")
    .select("user_id")
    .eq("lifecycle_state", "active")
    .gte("first_active_at", iso(LOOKBACK_HOURS * HOUR_MS))
    .lte("first_active_at", iso(SAY_HI_MIN_HOURS * HOUR_MS))
    .is("first_usage_at", null)
    .is("deleted_at", null)
    .limit(QUERY_LIMIT);
  throwOnError("first-win hermes ready query failed", hermesErr);

  const userIds = new Set<string>(subByUser.keys());
  for (const r of [...(hivraReady ?? []), ...(hermesReady ?? [])] as Array<{ user_id: string | null }>) {
    if (r.user_id) userIds.add(r.user_id);
  }
  const ids = [...userIds];
  summary.candidates = ids.length;
  if (ids.length === 0) return summary;

  // 2. Everything each candidate has ever launched (deleted rows included:
  //    having launched once means the launch email is moot), and the ledger.
  const agentsByUser = new Map<string, FirstWinAgent[]>();
  const everLaunched = new Set<string>();
  const sent = new Map<string, Set<string>>();
  const push = (userId: string, agent: FirstWinAgent) => {
    everLaunched.add(userId);
    const list = agentsByUser.get(userId);
    if (list) list.push(agent);
    else agentsByUser.set(userId, [agent]);
  };
  for (const part of chunk(ids, IN_CHUNK_SIZE)) {
    const hivra = await db
      .from("hivra_agents")
      .select("id, user_id, name, status, provisioned_at, first_usage_at")
      .in("user_id", part)
      .limit(QUERY_LIMIT);
    throwOnError("first-win hivra agents query failed", hivra.error);
    for (const r of (hivra.data ?? []) as Array<Record<string, string | null>>) {
      if (!r.user_id) continue;
      const live = r.status === "running";
      push(r.user_id, {
        id: String(r.id),
        lane: "hivra",
        name: r.name ?? null,
        readyAt: live ? r.provisioned_at ?? null : null,
        firstUsageAt: r.first_usage_at ?? null,
      });
    }
    const hermes = await db
      .from("hermes_instances")
      .select("id, user_id, name, first_active_at, first_usage_at, lifecycle_state, deleted_at")
      .in("user_id", part)
      .limit(QUERY_LIMIT);
    throwOnError("first-win hermes instances query failed", hermes.error);
    for (const r of (hermes.data ?? []) as Array<Record<string, string | null>>) {
      if (!r.user_id) continue;
      const live = r.lifecycle_state === "active" && !r.deleted_at;
      push(r.user_id, {
        id: String(r.id),
        lane: "hermes",
        name: r.name ?? null,
        readyAt: live ? r.first_active_at ?? null : null,
        firstUsageAt: r.first_usage_at ?? null,
      });
    }
    const ledger = await db
      .from("lifecycle_email_sends")
      .select("user_id, email_key")
      .in("user_id", part)
      .limit(QUERY_LIMIT);
    throwOnError("first-win ledger query failed", ledger.error);
    for (const r of (ledger.data ?? []) as Array<{ user_id: string; email_key: string }>) {
      const set = sent.get(r.user_id) ?? new Set<string>();
      set.add(r.email_key);
      sent.set(r.user_id, set);
    }
  }

  // 3. Plan: at most one email per user, capped.
  const planned: Planned[] = [];
  for (const userId of ids) {
    const keys = sent.get(userId) ?? new Set<string>();
    const agents = agentsByUser.get(userId) ?? [];
    const launch = selectLaunchNudge({
      subscription: subByUser.get(userId) ?? null,
      everLaunched: everLaunched.has(userId),
      sentKeys: keys,
      now,
    });
    if (launch) {
      planned.push({ userId, key: "first_win_launch", pick: launch });
      continue;
    }
    const agent = selectSayHiNudge({ agents, sentKeys: keys, now });
    if (agent) planned.push({ userId, key: "first_win_say_hi", agent });
  }
  if (planned.length > cap) {
    summary.capHit = true;
    planned.length = cap;
  }

  // 4. Send one at a time; ledger after Resend accepts.
  let captured = 0;
  for (const item of planned) {
    const key: FirstWinEmailKey = item.key;
    try {
      if (!clerkSecret) {
        summary.skipped_no_email += 1;
        continue;
      }
      const recipient = await resolveClerkRecipient(clerkSecret, item.userId);
      if (!recipient) {
        summary.skipped_no_email += 1;
        continue;
      }
      const res = await sendFirstWinEmail(key, {
        email: recipient.email,
        firstName: recipient.firstName,
        idempotencyKey: `lifecycle_${key}_${item.userId}`,
        ...(item.key === "first_win_launch"
          ? { profile: item.pick.profile, paid: item.pick.paid }
          : { agentName: item.agent.name, agentUrl: agentPageUrl(item.agent) }),
      });
      if (!res.sent) {
        summary.failed += 1;
        continue;
      }
      const { error: insertErr } = await db
        .from("lifecycle_email_sends")
        .upsert({ user_id: item.userId, email_key: key }, { onConflict: "user_id,email_key", ignoreDuplicates: true });
      if (insertErr) {
        summary.failed += 1;
        log.warn("first-win email sent but ledger insert failed", {
          source: LOG_SOURCE,
          emailKey: key,
          errorMessage: insertErr.message,
        });
        continue;
      }
      summary[key] += 1;
      captured += 1;
      posthogClient.capture({
        distinctId: item.userId,
        event: "lifecycle_email_sent",
        properties: { email_key: key, $insert_id: `lifecycle_email_sent_${key}_${item.userId}` },
      });
    } catch (err) {
      summary.failed += 1;
      log.warn("first-win email send failed", {
        source: LOG_SOURCE,
        emailKey: key,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
