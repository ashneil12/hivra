import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveInstanceAgentImageRepo } from "@/lib/services/webui-instance-builder";

import {
  decideUpdate,
  DIGEST_PATTERN,
  releaseImageRef,
  type HermesRelease,
  type ReleaseChannel,
  type UpdateDecision,
} from "./policy";
import { loadReleases } from "./store";

export interface BoxReleaseState {
  instanceId: string;
  channel: ReleaseChannel;
  imageRepo: string | null;
  currentDigest: string | null;
  currentVersion: string | null;
  updateHealth: string | null;
  decision: UpdateDecision;
  /** repo@sha256:... of the target, or null when none is offered. */
  targetImage: string | null;
}

const NO_DECISION: UpdateDecision = {
  target: null,
  direction: "none",
  autoMove: false,
  updateAvailable: false,
};

export const BOX_RELEASE_COLUMNS =
  "id, config, release_channel, agent_image_digest, agent_version, update_health";

interface BoxReleaseRow {
  id: string;
  config: Record<string, unknown> | null;
  release_channel: string | null;
  agent_image_digest: string | null;
  agent_version: string | null;
  update_health: string | null;
}

/**
 * What release a box should run, given the registry and what it last reported.
 * `reportedDigest` is the digest the box itself just measured (the roller
 * sends it), which beats the last stored one.
 */
export function evaluateBoxRelease(
  row: BoxReleaseRow,
  releases: readonly HermesRelease[],
  options: { reportedDigest?: string | null; imageRepo?: string | null } = {}
): BoxReleaseState {
  const channel: ReleaseChannel = row.release_channel === "canary" ? "canary" : "stable";
  const imageRepo = options.imageRepo ?? resolveInstanceAgentImageRepo(row.config);
  const reported = options.reportedDigest && DIGEST_PATTERN.test(options.reportedDigest)
    ? options.reportedDigest
    : null;
  const currentDigest = reported ?? row.agent_image_digest ?? null;
  const current = currentDigest
    ? releases.find((release) => release.digest === currentDigest) ?? null
    : null;
  const decision = imageRepo
    ? decideUpdate(releases, { instanceId: row.id, channel, imageRepo, currentDigest })
    : NO_DECISION;
  return {
    instanceId: row.id,
    channel,
    imageRepo,
    currentDigest,
    currentVersion: current?.version ?? row.agent_version ?? null,
    updateHealth: row.update_health,
    decision,
    targetImage: decision.target ? releaseImageRef(decision.target) : null,
  };
}

export async function loadBoxRelease(
  db: SupabaseClient,
  instanceId: string,
  options: { reportedDigest?: string | null; imageRepo?: string | null } = {}
): Promise<BoxReleaseState | null> {
  const { data, error } = await db
    .from("hermes_instances")
    .select(BOX_RELEASE_COLUMNS)
    .eq("id", instanceId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as BoxReleaseRow;
  const imageRepo = options.imageRepo ?? resolveInstanceAgentImageRepo(row.config);
  const releases = imageRepo ? await loadReleases(db, imageRepo) : [];
  return evaluateBoxRelease(row, releases, { ...options, imageRepo });
}
