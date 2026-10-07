import type { SupabaseClient } from "@supabase/supabase-js";

import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

import {
  DIGEST_PATTERN,
  RELEASE_COLUMNS,
  releaseStage,
  shouldHaltRelease,
  stagePatch,
  type HermesRelease,
  type ReleaseStage,
} from "./policy";

const SOURCE = "hermes-releases";

export type ReleaseEventKind =
  | "registered"
  | "promoted"
  | "halted"
  | "unhalted"
  | "updated"
  | "failed"
  | "rolled_back"
  | "paused";

/** Outcome kinds a box reports, mapped to the ones that count as a failure. */
const FAILURE_KINDS: readonly ReleaseEventKind[] = ["failed", "rolled_back", "paused"];
const OUTCOME_KINDS: readonly ReleaseEventKind[] = ["updated", ...FAILURE_KINDS];

export class ReleaseStoreError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
  }
}

export async function loadReleases(db: SupabaseClient, imageRepo?: string): Promise<HermesRelease[]> {
  let query = db.from("hermes_releases").select(RELEASE_COLUMNS);
  if (imageRepo) query = query.eq("image_repo", imageRepo);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
  if (error) throw new ReleaseStoreError("Failed to load releases", 500);
  return (data ?? []) as unknown as HermesRelease[];
}

async function loadRelease(db: SupabaseClient, id: string): Promise<HermesRelease> {
  const { data, error } = await db
    .from("hermes_releases")
    .select(RELEASE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ReleaseStoreError("Failed to load release", 500);
  if (!data) throw new ReleaseStoreError("Release not found", 404);
  return data as unknown as HermesRelease;
}

async function recordEvent(
  db: SupabaseClient,
  event: {
    releaseId: string | null;
    instanceId?: string | null;
    kind: ReleaseEventKind;
    digest?: string | null;
    detail?: string | null;
    actor?: string | null;
  }
): Promise<void> {
  const { error } = await db.from("hermes_release_events").insert({
    release_id: event.releaseId,
    instance_id: event.instanceId ?? null,
    kind: event.kind,
    digest: event.digest ?? null,
    detail: event.detail?.slice(0, 1000) ?? null,
    actor: event.actor ?? null,
  });
  if (error) {
    log.error("hermes release event write failed", new Error("release_event_write_failed"), {
      source: SOURCE,
      failureType: "release_event_write_failed",
      kind: event.kind,
    });
  }
}

export async function registerRelease(
  db: SupabaseClient,
  input: { imageRepo: string; version: string; digest: string; actor: string; notes?: string | null }
): Promise<{ release: HermesRelease; created: boolean }> {
  if (!DIGEST_PATTERN.test(input.digest)) throw new ReleaseStoreError("Digest must be sha256:<64 hex>");
  const version = input.version.trim();
  if (!version) throw new ReleaseStoreError("Version is required");

  const existing = await db
    .from("hermes_releases")
    .select(RELEASE_COLUMNS)
    .eq("image_repo", input.imageRepo)
    .eq("digest", input.digest)
    .maybeSingle();
  if (existing.error) throw new ReleaseStoreError("Failed to check existing releases", 500);
  if (existing.data) return { release: existing.data as unknown as HermesRelease, created: false };

  const { data, error } = await db
    .from("hermes_releases")
    .insert({
      image_repo: input.imageRepo,
      version,
      digest: input.digest,
      channel: "canary",
      rollout_percent: 0,
      pilot_instance_ids: [],
      halted: false,
      promoted_at: null,
      notes: input.notes ?? null,
      created_by: input.actor,
    })
    .select(RELEASE_COLUMNS)
    .single();
  if (error || !data) throw new ReleaseStoreError("Failed to register release", 500);
  const release = data as unknown as HermesRelease;
  await recordEvent(db, {
    releaseId: release.id,
    kind: "registered",
    digest: release.digest,
    detail: `${release.image_repo} ${release.version}`,
    actor: input.actor,
  });
  return { release, created: true };
}

/**
 * Move a release one rung up the ladder: registered -> canary -> pilot (one
 * box) -> ten percent -> full. A halted release cannot be promoted.
 */
export async function promoteRelease(
  db: SupabaseClient,
  id: string,
  options: { to: ReleaseStage; pilotInstanceId?: string; actor: string }
): Promise<HermesRelease> {
  const release = await loadRelease(db, id);
  if (release.halted) throw new ReleaseStoreError("A halted release cannot be promoted. Unhalt it first.", 409);
  const from = releaseStage(release);

  let patch;
  try {
    patch = stagePatch(from, options.to, { pilotInstanceId: options.pilotInstanceId });
  } catch (err) {
    throw new ReleaseStoreError(err instanceof Error ? err.message : "Invalid promotion", 400);
  }

  const { data, error } = await db
    .from("hermes_releases")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    // Optimistic guard: two operators promoting at once must not skip a rung.
    .eq("channel", release.channel)
    .eq("rollout_percent", release.rollout_percent)
    .select(RELEASE_COLUMNS)
    .maybeSingle();
  if (error) throw new ReleaseStoreError("Failed to promote release", 500);
  if (!data) throw new ReleaseStoreError("The release changed while promoting; reload and retry", 409);
  await recordEvent(db, {
    releaseId: id,
    kind: "promoted",
    digest: release.digest,
    detail: `${from} -> ${options.to}`,
    actor: options.actor,
  });
  return data as unknown as HermesRelease;
}

export async function haltRelease(
  db: SupabaseClient,
  id: string,
  options: { reason: string; actor: string }
): Promise<HermesRelease> {
  const release = await loadRelease(db, id);
  if (release.halted) return release;
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("hermes_releases")
    .update({
      halted: true,
      halted_reason: options.reason.slice(0, 500),
      halted_at: now,
      halted_by: options.actor,
      updated_at: now,
    })
    .eq("id", id)
    .select(RELEASE_COLUMNS)
    .single();
  if (error || !data) throw new ReleaseStoreError("Failed to halt release", 500);
  await recordEvent(db, {
    releaseId: id,
    kind: "halted",
    digest: release.digest,
    detail: options.reason,
    actor: options.actor,
  });
  return data as unknown as HermesRelease;
}

export async function unhaltRelease(
  db: SupabaseClient,
  id: string,
  options: { actor: string }
): Promise<HermesRelease> {
  const release = await loadRelease(db, id);
  if (!release.halted) return release;
  const { data, error } = await db
    .from("hermes_releases")
    .update({
      halted: false,
      halted_reason: null,
      halted_at: null,
      halted_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(RELEASE_COLUMNS)
    .single();
  if (error || !data) throw new ReleaseStoreError("Failed to unhalt release", 500);
  await recordEvent(db, { releaseId: id, kind: "unhalted", digest: release.digest, actor: options.actor });
  return data as unknown as HermesRelease;
}

export interface ReleaseHealth {
  succeededBoxes: number;
  failedBoxes: number;
}

/** Latest outcome per box for a release, reduced to distinct-box counts. */
export async function loadReleaseHealth(db: SupabaseClient, releaseId: string): Promise<ReleaseHealth> {
  const { data, error } = await db
    .from("hermes_release_events")
    .select("instance_id, kind, created_at")
    .eq("release_id", releaseId)
    .in("kind", [...OUTCOME_KINDS])
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw new ReleaseStoreError("Failed to load release outcomes", 500);
  const latest = new Map<string, ReleaseEventKind>();
  for (const row of (data ?? []) as Array<{ instance_id: string | null; kind: ReleaseEventKind }>) {
    if (row.instance_id && !latest.has(row.instance_id)) latest.set(row.instance_id, row.kind);
  }
  let succeededBoxes = 0;
  let failedBoxes = 0;
  for (const kind of latest.values()) {
    if (FAILURE_KINDS.includes(kind)) failedBoxes += 1;
    else succeededBoxes += 1;
  }
  return { succeededBoxes, failedBoxes };
}

export interface BoxOutcome {
  instanceId: string;
  userId?: string | null;
  kind: Extract<ReleaseEventKind, "updated" | "failed" | "rolled_back" | "paused">;
  /** Digest the box was asked to run (the release being judged). */
  targetDigest: string | null;
  detail?: string | null;
}

/**
 * Record a box's outcome for a release and halt the release automatically when
 * enough boxes have failed it. Idempotent for repeated halts.
 */
export async function recordBoxOutcome(
  db: SupabaseClient,
  outcome: BoxOutcome
): Promise<{ releaseId: string | null; halted: boolean }> {
  let release: HermesRelease | null = null;
  if (outcome.targetDigest && DIGEST_PATTERN.test(outcome.targetDigest)) {
    const { data } = await db
      .from("hermes_releases")
      .select(RELEASE_COLUMNS)
      .eq("digest", outcome.targetDigest)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    release = (data as unknown as HermesRelease | null) ?? null;
  }
  await recordEvent(db, {
    releaseId: release?.id ?? null,
    instanceId: outcome.instanceId,
    kind: outcome.kind,
    digest: outcome.targetDigest,
    detail: outcome.detail,
  });
  if (!release || release.halted || outcome.kind === "updated") {
    return { releaseId: release?.id ?? null, halted: false };
  }

  const health = await loadReleaseHealth(db, release.id);
  const verdict = shouldHaltRelease(health);
  if (!verdict.halt) return { releaseId: release.id, halted: false };

  await haltRelease(db, release.id, { reason: `Auto-halted: ${verdict.reason}`, actor: "auto" });
  log.warn("hermes release auto-halted", {
    source: SOURCE,
    failureType: "release_auto_halted",
    releaseId: release.id,
    version: release.version,
    failedBoxes: health.failedBoxes,
    succeededBoxes: health.succeededBoxes,
  });
  await reportOpsEvent({
    source: "hermes-release-auto-halt",
    severity: "error",
    title: `Hermes release ${release.version} halted automatically`,
    message: `Release ${release.version} was halted: ${verdict.reason}. No box is offered it until an operator unhalts it, and boxes running it move back to the newest release that is not halted.`,
    route: "/api/instances/[id]/update-report",
    metadata: {
      releaseId: release.id,
      version: release.version,
      failedBoxes: health.failedBoxes,
      succeededBoxes: health.succeededBoxes,
    },
  });
  return { releaseId: release.id, halted: true };
}
