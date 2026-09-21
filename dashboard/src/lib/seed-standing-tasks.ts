/**
 * Auto-seed standing-task sweep.
 *
 * Newly-running agents that captured a goal / first_task during onboarding are
 * given ONE daily standing task automatically, so the "it worked while you were
 * away" loop fires without the user discovering + configuring scheduled tasks
 * themselves. Driven by /api/cron/seed-standing-tasks, which is DEFAULT-OFF
 * behind AUTO_SEED_STANDING_TASKS_ENABLED — the deploy is inert until that flag
 * is set true in the Vercel env.
 *
 * Why a cron (not a provisioning hook): the provisioning files
 * (proxmox-instance-service / webui-instance-builder / instance-orchestrator)
 * are divergent between canary and prod, so hooking them wouldn't port cleanly.
 * A cron lives in the in-sync api/cron area and ports to prod as-is.
 *
 * CONSERVATIVE by design — every guard must hold before a single task is seeded:
 *   - status = 'running', deleted_at IS NULL
 *   - goal IS NOT NULL OR first_task IS NOT NULL (only goal-having agents)
 *   - standing_task_seeded_at IS NULL (per-instance idempotency stamp — set once
 *     after a successful seed, so an agent is never re-seeded)
 *   - the box currently has ZERO cron jobs (second safety net: never add a 2nd
 *     task to someone who already created one; also keeps us within the free
 *     one-standing-task entitlement). If the box's job list can't be READ, we
 *     SKIP that instance — fail safe, never seed on an unknown count.
 *   - hard per-run batch cap (AUTO_SEED_STANDING_TASKS_BATCH_SIZE, default 25)
 *
 * Action: create one task on schedule `0 9 * * *` (09:00 UTC — the same default
 * the manual TaskModal uses) whose prompt asks the agent to make daily progress
 * on the user's stated goal/first_task and summarize. Delivery is "telegram"
 * when the box has a Telegram connection on record (channel_connections), else
 * "local" (the agent's own surface, read in the dashboard chat) — the same
 * delivery vocabulary the box cron engine + manual UI use.
 *
 * Box calls reuse the exact signed-header / gateway-probe path the authenticated
 * /api/instances/[id]/cron route uses, via getSecureUserInstance (which only
 * needs the row's id + user_id, both available to the cron). The box list/create
 * is injected so the sweep is unit-testable without a live box.
 */

import "server-only";

import crypto from "node:crypto";

import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import {
  getSecureUserInstance,
  type SecureUserInstanceResult,
} from "@/lib/services/instance-security";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "seed-standing-tasks";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 200;
const QUERY_LIMIT = 1000;
const CRON_REQUEST_TIMEOUT_MS = 15_000;

/** 09:00 UTC daily — mirrors the manual TaskModal default ("Daily at 9:00 AM"). */
export const STANDING_TASK_SCHEDULE = "0 9 * * *";
export const STANDING_TASK_NAME = "Daily progress";
/** Profile every newly-provisioned box has; matches the route's create default. */
const DEFAULT_PROFILE = "default";

// ---------- row shapes ----------

export interface SeedCandidateRow {
  id: string;
  user_id: string | null;
  name: string | null;
  goal: string | null;
  first_task: string | null;
  standing_task_seeded_at: string | null;
}

export interface StandingTaskSeedSummary {
  /** Candidate rows returned by the eligibility query. */
  candidates: number;
  /** Tasks successfully created + stamped. */
  seeded: number;
  /** Skipped because the box already had >= 1 cron job. */
  skipped_existing_jobs: number;
  /** Skipped because the box's job list couldn't be read (fail-safe). */
  skipped_unreadable: number;
  /** Skipped because the instance was no longer reachable/secure. */
  skipped_unreachable: number;
  /** Seeded the box but the idempotency stamp write failed (counted, logged). */
  failed_stamp: number;
  /** Per-instance errors that didn't fit the buckets above. */
  failed: number;
  /** True when the batch cap truncated the candidate list. */
  capHit: boolean;
}

// ---------- pure helpers (unit-tested) ----------

/** First non-empty trimmed value among the args, or null. */
function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * The standing-task prompt derived from the agent's captured goal/first_task.
 * Exported + pure so the copy is locked in by a unit test. Returns null when
 * the agent captured neither — such a row is never eligible (the query already
 * filters it out; this is a belt-and-braces guard).
 */
export function buildStandingTaskPrompt(row: {
  goal: string | null;
  first_task: string | null;
}): string | null {
  const objective = firstNonEmpty(row.goal, row.first_task);
  if (!objective) return null;
  return (
    `Each morning, make concrete progress on this objective: ${objective}. ` +
    `Take the next useful step (don't just plan), then send a short summary of ` +
    `what you did and what's next. If there's nothing new to do, say so briefly.`
  );
}

/**
 * Whether a candidate row is eligible to be seeded. The DB query already encodes
 * status/deleted/seeded/goal filters, but re-checking here keeps the predicate
 * unit-testable and guards against query drift.
 */
export function isSeedEligible(row: SeedCandidateRow): boolean {
  if (!row.user_id) return false;
  if (row.standing_task_seeded_at) return false;
  return buildStandingTaskPrompt(row) !== null;
}

/** Delivery channel for the seeded task: telegram when connected, else local. */
export function resolveDeliveryChannel(hasTelegram: boolean): "telegram" | "local" {
  return hasTelegram ? "telegram" : "local";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSeedBatchSize(): number {
  return Math.min(MAX_BATCH_SIZE, envInt("AUTO_SEED_STANDING_TASKS_BATCH_SIZE", DEFAULT_BATCH_SIZE));
}

// ---------- box plumbing (mirrors /api/instances/[id]/cron) ----------

type SecureInstanceOk = Extract<SecureUserInstanceResult, { error: null }>;

function buildSignedHeaders(apiServerKey: string, rawBody?: string): Headers {
  const timestamp = Date.now().toString();
  const signedPayload = rawBody ? `${timestamp}.${rawBody}` : timestamp;
  const signature = crypto
    .createHmac("sha256", apiServerKey)
    .update(signedPayload)
    .digest("hex");
  return new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    Connection: "close",
    Authorization: `Bearer ${apiServerKey}`,
    "X-Hermes-Timestamp": timestamp,
    "X-Hermes-Signature": signature,
  });
}

/**
 * Count the box's existing cron jobs across all profiles. Returns null when the
 * list can't be read (non-2xx or transport error) → the caller fails safe and
 * SKIPS the instance rather than seeding on an unknown count.
 */
export async function countBoxJobs(secureInstance: SecureInstanceOk): Promise<number | null> {
  try {
    const { response } = await fetchFirstReachableGatewayResponse({
      baseUrl: secureInstance.instance.gateway_url,
      pathname: `/_sidecar/api/cron/jobs?${new URLSearchParams({ profile: "all" }).toString()}`,
      instanceIpv4: secureInstance.instanceIpv4,
      method: "GET",
      headers: buildSignedHeaders(secureInstance.apiServerKey),
      timeoutMs: CRON_REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) {
      await response.text().catch(() => "");
      return null;
    }
    const payload = await response.json().catch(() => null);
    return Array.isArray(payload) ? payload.length : 0;
  } catch {
    return null;
  }
}

/** Create one standing task on the box. Returns true on a 2xx response. */
export async function createBoxStandingTask(
  secureInstance: SecureInstanceOk,
  task: { prompt: string; schedule: string; name: string; deliver: string },
): Promise<boolean> {
  const rawBody = JSON.stringify(task);
  try {
    const { response } = await fetchFirstReachableGatewayResponse({
      baseUrl: secureInstance.instance.gateway_url,
      pathname: `/_sidecar/api/cron/jobs?${new URLSearchParams({ profile: DEFAULT_PROFILE }).toString()}`,
      instanceIpv4: secureInstance.instanceIpv4,
      method: "POST",
      headers: buildSignedHeaders(secureInstance.apiServerKey, rawBody),
      body: rawBody,
      timeoutMs: CRON_REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) {
      await response.text().catch(() => "");
      return false;
    }
    await response.json().catch(() => null);
    return true;
  } catch {
    return false;
  }
}

// ---------- injectable seams (tests stub these) ----------

export type SecureInstanceLoader = (
  id: string,
  userId: string,
) => Promise<SecureInstanceOk | null>;

export type BoxJobCounter = (secureInstance: SecureInstanceOk) => Promise<number | null>;

export type BoxTaskCreator = (
  secureInstance: SecureInstanceOk,
  task: { prompt: string; schedule: string; name: string; deliver: string },
) => Promise<boolean>;

export type TelegramConnectionChecker = (instanceIds: string[]) => Promise<Set<string>>;

const defaultLoadSecureInstance: SecureInstanceLoader = async (id, userId) => {
  const result = await getSecureUserInstance({ id, userId, requireRunning: true });
  if (result.error !== null || !result.instance) return null;
  return result as SecureInstanceOk;
};

/**
 * The set of instance ids (target_kind='hermes') that have a Telegram
 * connection on record. One query for the whole batch.
 */
const defaultTelegramConnections: TelegramConnectionChecker = async (instanceIds) => {
  const connected = new Set<string>();
  if (!supabaseAdmin || instanceIds.length === 0) return connected;
  const { data, error } = await supabaseAdmin
    .from("channel_connections")
    .select("target_id")
    .eq("channel", "telegram")
    .eq("target_kind", "hermes")
    .in("target_id", instanceIds);
  if (error) {
    // Degrade to "no telegram" rather than failing the sweep — the task still
    // seeds, it just delivers to the local surface.
    log.warn("seed-standing-tasks: telegram connection lookup failed", {
      source: LOG_SOURCE,
      errorMessage: error.message,
    });
    return connected;
  }
  for (const row of (data ?? []) as Array<{ target_id: string }>) {
    if (row.target_id) connected.add(row.target_id);
  }
  return connected;
};

// ---------- the sweep ----------

export async function runStandingTaskSeedSweep(opts?: {
  now?: Date;
  batchSize?: number;
  loadSecureInstance?: SecureInstanceLoader;
  countBoxJobs?: BoxJobCounter;
  createBoxStandingTask?: BoxTaskCreator;
  telegramConnections?: TelegramConnectionChecker;
}): Promise<StandingTaskSeedSummary> {
  const summary: StandingTaskSeedSummary = {
    candidates: 0,
    seeded: 0,
    skipped_existing_jobs: 0,
    skipped_unreadable: 0,
    skipped_unreachable: 0,
    failed_stamp: 0,
    failed: 0,
    capHit: false,
  };

  if (!supabaseAdmin) throw new Error("Database not configured");
  const db = supabaseAdmin;

  const now = opts?.now ?? new Date();
  const batchSize = Math.max(1, opts?.batchSize ?? resolveSeedBatchSize());
  const loadSecureInstance = opts?.loadSecureInstance ?? defaultLoadSecureInstance;
  const countJobs = opts?.countBoxJobs ?? countBoxJobs;
  const createTask = opts?.createBoxStandingTask ?? createBoxStandingTask;
  const telegramConnections = opts?.telegramConnections ?? defaultTelegramConnections;

  // Eligibility query: running, not deleted, goal OR first_task present, never
  // seeded. The 0-jobs guard is a per-box check below (can't be a SQL filter).
  const { data, error } = await db
    .from("hermes_instances")
    .select("id, user_id, name, goal, first_task, standing_task_seeded_at")
    .eq("status", "running")
    .is("deleted_at", null)
    .is("standing_task_seeded_at", null)
    .or("goal.not.is.null,first_task.not.is.null")
    .limit(QUERY_LIMIT);
  if (error) throw new Error(`candidate query failed: ${error.message || "query failed"}`);

  let candidates = ((data ?? []) as SeedCandidateRow[]).filter(isSeedEligible);
  summary.candidates = candidates.length;
  if (candidates.length === 0) return summary;

  if (candidates.length > batchSize) {
    summary.capHit = true;
    candidates = candidates.slice(0, batchSize);
  }

  // One Telegram-connection lookup for the whole (capped) batch.
  const telegramIds = await telegramConnections(candidates.map((c) => c.id));

  let captured = 0;
  for (const row of candidates) {
    const userId = row.user_id;
    if (!userId) {
      summary.failed += 1;
      continue;
    }
    try {
      const secureInstance = await loadSecureInstance(row.id, userId);
      if (!secureInstance) {
        summary.skipped_unreachable += 1;
        continue;
      }

      // 0-existing-jobs guard. Unreadable → fail safe (skip, never seed).
      const existing = await countJobs(secureInstance);
      if (existing === null) {
        summary.skipped_unreadable += 1;
        continue;
      }
      if (existing >= 1) {
        // Stamp anyway: the agent already has a standing task (the user made
        // one), so the loop is live and we never want to re-evaluate this row.
        await stampSeeded(db, row.id, now, summary);
        summary.skipped_existing_jobs += 1;
        continue;
      }

      const prompt = buildStandingTaskPrompt(row);
      if (!prompt) {
        // isSeedEligible already filtered these out; defensive.
        summary.failed += 1;
        continue;
      }
      const deliver = resolveDeliveryChannel(telegramIds.has(row.id));

      const created = await createTask(secureInstance, {
        prompt,
        schedule: STANDING_TASK_SCHEDULE,
        name: STANDING_TASK_NAME,
        deliver,
      });
      if (!created) {
        summary.failed += 1;
        continue;
      }

      const stamped = await stampSeeded(db, row.id, now, summary);
      if (!stamped) continue; // failed_stamp already incremented

      summary.seeded += 1;
      captured += 1;
      posthogClient.capture({
        distinctId: userId,
        event: "standing_task_auto_seeded",
        properties: {
          instance_id: row.id,
          deliver,
          $insert_id: `standing_task_auto_seeded_${row.id}`,
        },
      });
    } catch (err) {
      summary.failed += 1;
      log.warn("seed-standing-tasks: per-instance seed failed", {
        source: LOG_SOURCE,
        instanceId: row.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (captured > 0) {
    try {
      await posthogClient.flush();
    } catch (err) {
      log.warn("seed-standing-tasks: posthog flush failed", {
        source: LOG_SOURCE,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

/**
 * Stamp standing_task_seeded_at. Re-stamps only when still NULL so a concurrent
 * run never clobbers an earlier stamp. Returns false (and increments
 * failed_stamp) on a DB error — the box task is already created, so the 0-jobs
 * guard will keep the next run from double-seeding even if this write failed.
 */
async function stampSeeded(
  db: NonNullable<typeof supabaseAdmin>,
  instanceId: string,
  now: Date,
  summary: StandingTaskSeedSummary,
): Promise<boolean> {
  const { error } = await db
    .from("hermes_instances")
    .update({ standing_task_seeded_at: now.toISOString() })
    .eq("id", instanceId)
    .is("standing_task_seeded_at", null);
  if (error) {
    summary.failed_stamp += 1;
    log.warn("seed-standing-tasks: seed stamp write failed", {
      source: LOG_SOURCE,
      instanceId,
      errorMessage: error.message,
    });
    return false;
  }
  return true;
}
