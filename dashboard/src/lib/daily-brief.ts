/**
 * Auto-seed daily-brief sweep + read-back.
 *
 * Gives every running agent ONE "Daily brief" scheduled job (08:00 UTC,
 * deliver=local) so the command panel's "Today's brief" is written by the user's
 * OWN agent — "here's what changed, what needs you, what I'll do" — instead of a
 * static heuristic. Driven by /api/cron/seed-daily-brief, DEFAULT-OFF behind
 * DAILY_BRIEF_SEED_ENABLED — the deploy is inert until that flag is set.
 *
 * Mirrors the seed-standing-tasks sweep (same signed box-call plumbing, same
 * injectable seams for tests, per-instance idempotency via a stamp column). Two
 * differences: (1) every running agent is eligible (a brief needs no captured
 * goal); (2) the seeded job is a PLATFORM job, exempt from the free-tier
 * one-standing-task limit, so it never eats a Free user's slot.
 *
 * Read-back: fetchBriefRunText() finds the box's "Daily brief" job and returns
 * its latest run's final message for the panel. It degrades to null on any box
 * error (incl. an agent image without the runs endpoint), so the panel simply
 * keeps its heuristic brief — nothing breaks if the read-back isn't available.
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
import {
  DAILY_BRIEF_NAME,
  DAILY_BRIEF_SCHEDULE,
  DAILY_BRIEF_DELIVER,
  isDailyBriefJob,
  isPlatformDailyBriefJob,
} from "@/lib/daily-brief-shared";

// Re-export the client-safe constants/matchers so server callers keep importing
// them from "@/lib/daily-brief".
export {
  DAILY_BRIEF_NAME,
  DAILY_BRIEF_SCHEDULE,
  DAILY_BRIEF_DELIVER,
  isDailyBriefJob,
  isPlatformDailyBriefJob,
};

const LOG_SOURCE = "seed-daily-brief";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 200;
const QUERY_LIMIT = 1000;
const CRON_REQUEST_TIMEOUT_MS = 15_000;

const DEFAULT_PROFILE = "default";

// ---------- row shapes ----------

export interface BriefCandidateRow {
  id: string;
  user_id: string | null;
  daily_brief_seeded_at: string | null;
}

export interface DailyBriefSeedSummary {
  candidates: number;
  seeded: number;
  /** Skipped because a "Daily brief" job already existed on the box. */
  skipped_existing: number;
  /** Skipped because the box's job list couldn't be read (fail-safe). */
  skipped_unreadable: number;
  /** Skipped because the instance was no longer reachable/secure. */
  skipped_unreachable: number;
  /** Seeded the box but the idempotency stamp write failed (counted, logged). */
  failed_stamp: number;
  failed: number;
  capHit: boolean;
}

// ---------- pure helpers (unit-tested) ----------

/** The daily-brief prompt. Exported + pure so the copy is locked by a test. */
export function buildDailyBriefPrompt(): string {
  return (
    "Write my morning brief. In a few short, skimmable lines and no preamble: " +
    "what changed since yesterday across my connected tools and tasks, what needs " +
    "my attention or a decision today, and the one or two things you'll take care " +
    "of yourself. If nothing needs attention, say so in a single line."
  );
}

/** Whether a candidate row is eligible to be seeded (belt-and-braces vs the SQL filter). */
export function isBriefSeedEligible(row: BriefCandidateRow): boolean {
  if (!row.user_id) return false;
  if (row.daily_brief_seeded_at) return false;
  return true;
}

/**
 * Best-effort extraction of a run's final human-readable text. The box's runs
 * endpoint shape isn't guaranteed across agent images, so we probe a few common
 * fields and fall back to the last assistant message; null when nothing usable.
 */
export function extractBriefRunText(run: unknown): string | null {
  if (!run || typeof run !== "object") return null;
  const r = run as Record<string, unknown>;
  const directKeys = ["final_message", "finalMessage", "summary", "output", "result", "text", "message"];
  for (const k of directKeys) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // messages: [...] → last assistant/string content.
  const messages = r.messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { content?: unknown; text?: unknown } | undefined;
      const c = m?.content ?? m?.text;
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  }
  return null;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveBriefSeedEnabled(): boolean {
  return envBool("DAILY_BRIEF_SEED_ENABLED", false);
}

function resolveBriefSeedBatchSize(): number {
  return Math.min(MAX_BATCH_SIZE, envInt("DAILY_BRIEF_SEED_BATCH_SIZE", DEFAULT_BATCH_SIZE));
}

// ---------- box plumbing (mirrors /api/instances/[id]/cron) ----------

type SecureInstanceOk = Extract<SecureUserInstanceResult, { error: null }>;

function buildSignedHeaders(apiServerKey: string, rawBody?: string): Headers {
  const timestamp = Date.now().toString();
  const signedPayload = rawBody ? `${timestamp}.${rawBody}` : timestamp;
  const signature = crypto.createHmac("sha256", apiServerKey).update(signedPayload).digest("hex");
  return new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    Connection: "close",
    Authorization: `Bearer ${apiServerKey}`,
    "X-Hermes-Timestamp": timestamp,
    "X-Hermes-Signature": signature,
  });
}

/** List the box's cron jobs (all profiles). Null when the list can't be read. */
export async function listBoxJobs(secureInstance: SecureInstanceOk): Promise<unknown[] | null> {
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
    // Fail safe: a non-array 2xx (unexpected/wrapped shape) is "unreadable", not
    // "empty" — treating it as empty could double-seed a box that already has a
    // brief job. The caller skips on null; only a real array drives create.
    return Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** Create the "Daily brief" job on the box. Returns true on a 2xx response. */
export async function createBoxBriefJob(secureInstance: SecureInstanceOk): Promise<boolean> {
  const rawBody = JSON.stringify({
    prompt: buildDailyBriefPrompt(),
    schedule: DAILY_BRIEF_SCHEDULE,
    name: DAILY_BRIEF_NAME,
    deliver: DAILY_BRIEF_DELIVER,
  });
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

/**
 * The agent-written brief for the panel: find the box's "Daily brief" job, read
 * its latest run, extract the final message. Returns null on ANY box error (incl.
 * an agent image without the runs endpoint) — the panel then keeps its heuristic.
 */
export async function fetchBriefRunText(secureInstance: SecureInstanceOk): Promise<string | null> {
  const jobs = await listBoxJobs(secureInstance);
  if (!jobs) return null;
  const briefJob = jobs.find(isDailyBriefJob) as { id?: unknown } | undefined;
  const jobId = briefJob && typeof briefJob.id === "string" ? briefJob.id : null;
  if (!jobId) return null;
  try {
    const { response } = await fetchFirstReachableGatewayResponse({
      baseUrl: secureInstance.instance.gateway_url,
      pathname: `/_sidecar/api/cron/jobs/${encodeURIComponent(jobId)}/runs?${new URLSearchParams({
        limit: "1",
      }).toString()}`,
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
    const runs = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { runs?: unknown[] })?.runs)
        ? (payload as { runs: unknown[] }).runs
        : [];
    return runs.length ? extractBriefRunText(runs[0]) : null;
  } catch {
    return null;
  }
}

// ---------- injectable seams (tests stub these) ----------

export type SecureInstanceLoader = (id: string, userId: string) => Promise<SecureInstanceOk | null>;
export type BoxJobLister = (secureInstance: SecureInstanceOk) => Promise<unknown[] | null>;
export type BoxBriefCreator = (secureInstance: SecureInstanceOk) => Promise<boolean>;

const defaultLoadSecureInstance: SecureInstanceLoader = async (id, userId) => {
  const result = await getSecureUserInstance({ id, userId, requireRunning: true });
  if (result.error !== null || !result.instance) return null;
  return result as SecureInstanceOk;
};

// ---------- the sweep ----------

export async function runDailyBriefSeedSweep(opts?: {
  now?: Date;
  batchSize?: number;
  loadSecureInstance?: SecureInstanceLoader;
  listBoxJobs?: BoxJobLister;
  createBoxBriefJob?: BoxBriefCreator;
}): Promise<DailyBriefSeedSummary> {
  const summary: DailyBriefSeedSummary = {
    candidates: 0,
    seeded: 0,
    skipped_existing: 0,
    skipped_unreadable: 0,
    skipped_unreachable: 0,
    failed_stamp: 0,
    failed: 0,
    capHit: false,
  };

  if (!supabaseAdmin) throw new Error("Database not configured");
  const db = supabaseAdmin;

  const now = opts?.now ?? new Date();
  const batchSize = Math.max(1, opts?.batchSize ?? resolveBriefSeedBatchSize());
  const loadSecureInstance = opts?.loadSecureInstance ?? defaultLoadSecureInstance;
  const listJobs = opts?.listBoxJobs ?? listBoxJobs;
  const createBrief = opts?.createBoxBriefJob ?? createBoxBriefJob;

  const { data, error } = await db
    .from("hermes_instances")
    .select("id, user_id, daily_brief_seeded_at")
    .eq("status", "running")
    .is("deleted_at", null)
    .is("daily_brief_seeded_at", null)
    .limit(QUERY_LIMIT);
  if (error) throw new Error(`candidate query failed: ${error.message || "query failed"}`);

  let candidates = ((data ?? []) as BriefCandidateRow[]).filter(isBriefSeedEligible);
  summary.candidates = candidates.length;
  if (candidates.length === 0) return summary;

  if (candidates.length > batchSize) {
    summary.capHit = true;
    candidates = candidates.slice(0, batchSize);
  }

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

      // Idempotency belt-and-braces vs the stamp: if a brief job already exists
      // (e.g. a prior seed whose stamp write failed), stamp + skip. Unreadable →
      // fail safe (skip, never risk a duplicate).
      const jobs = await listJobs(secureInstance);
      if (jobs === null) {
        summary.skipped_unreadable += 1;
        continue;
      }
      if (jobs.some(isDailyBriefJob)) {
        await stampSeeded(db, row.id, now, summary);
        summary.skipped_existing += 1;
        continue;
      }

      const created = await createBrief(secureInstance);
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
        event: "daily_brief_auto_seeded",
        properties: { instance_id: row.id, $insert_id: `daily_brief_auto_seeded_${row.id}` },
      });
    } catch (err) {
      summary.failed += 1;
      log.warn("seed-daily-brief: per-instance seed failed", {
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
      log.warn("seed-daily-brief: posthog flush failed", {
        source: LOG_SOURCE,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

/** Stamp daily_brief_seeded_at (only while still NULL, so concurrent runs don't clobber). */
async function stampSeeded(
  db: NonNullable<typeof supabaseAdmin>,
  instanceId: string,
  now: Date,
  summary: DailyBriefSeedSummary,
): Promise<boolean> {
  const { error } = await db
    .from("hermes_instances")
    .update({ daily_brief_seeded_at: now.toISOString() })
    .eq("id", instanceId)
    .is("daily_brief_seeded_at", null);
  if (error) {
    summary.failed_stamp += 1;
    log.warn("seed-daily-brief: seed stamp write failed", {
      source: LOG_SOURCE,
      instanceId,
      errorMessage: error.message,
    });
    return false;
  }
  return true;
}
