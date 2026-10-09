import { resolveInstanceAgentImageRepo } from "@/lib/services/webui-instance-builder";
import {
  NOFORK_LOCAL_REPO,
  NOFORK_OVERLAY_REPO,
  type NoForkMigrationStatus,
} from "@/lib/services/no-fork-migration-builder";

import { releaseImageRef, resolveTargetRelease, type HermesRelease, type ReleaseChannel } from "./policy";

/**
 * Whether a box can be offered "Update to latest Hermes": the one-click move from the Hivra Hermes
 * fork image onto stock upstream Hermes plus the Hivra overlay. Pure; the route supplies the row and
 * the registry's releases of the overlay repository.
 */
export type NoForkOfferReason =
  | "available"
  | "already_upstream"
  | "not_on_fork_image"
  | "not_running"
  | "no_release";

export interface NoForkOffer {
  available: boolean;
  reason: NoForkOfferReason;
  /** Set once the box runs upstream Hermes by itself. */
  alreadyUpstream: boolean;
  target: { version: string; digest: string; overlayImage: string } | null;
}

interface OfferRow {
  id: string;
  status: string | null;
  backend?: string | null;
  release_channel?: string | null;
  config: Record<string, unknown> | null;
}

export function evaluateNoForkOffer(row: OfferRow, releases: readonly HermesRelease[]): NoForkOffer {
  const repo = resolveInstanceAgentImageRepo(row.config);
  if (repo === NOFORK_LOCAL_REPO) {
    return { available: false, reason: "already_upstream", alreadyUpstream: true, target: null };
  }
  if (!repo || !/vanilla-hermes-agent/.test(repo)) {
    return { available: false, reason: "not_on_fork_image", alreadyUpstream: false, target: null };
  }
  if (row.status !== "running" || (row.backend && row.backend !== "gateway")) {
    return { available: false, reason: "not_running", alreadyUpstream: false, target: null };
  }
  const channel: ReleaseChannel = row.release_channel === "canary" ? "canary" : "stable";
  const release = resolveTargetRelease(releases, {
    instanceId: row.id,
    channel,
    imageRepo: NOFORK_OVERLAY_REPO,
  });
  if (!release) return { available: false, reason: "no_release", alreadyUpstream: false, target: null };
  return {
    available: true,
    reason: "available",
    alreadyUpstream: false,
    target: { version: release.version, digest: release.digest, overlayImage: releaseImageRef(release) },
  };
}

export function parseNoForkStatus(raw: string | null | undefined): NoForkMigrationStatus | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.trim().split("\n").pop() ?? "") as Partial<NoForkMigrationStatus>;
    if (!parsed || typeof parsed.state !== "string" || typeof parsed.phase !== "string") return null;
    return {
      state: parsed.state as NoForkMigrationStatus["state"],
      phase: parsed.phase as NoForkMigrationStatus["phase"],
      message: typeof parsed.message === "string" ? parsed.message : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      ...(typeof parsed.fromVersion === "string" ? { fromVersion: parsed.fromVersion } : {}),
      ...(typeof parsed.toVersion === "string" ? { toVersion: parsed.toVersion } : {}),
      ...(Array.isArray(parsed.checks) ? { checks: parsed.checks.filter((c): c is string => typeof c === "string") } : {}),
    };
  } catch {
    return null;
  }
}
