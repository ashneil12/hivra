import { createHash } from "node:crypto";

/**
 * Pure release-channel policy: which release a box should run, when a release
 * has failed enough to halt, and the promotion ladder. No I/O, so every rule is
 * unit-tested and shared by the roller endpoint, the cron, the UPDATE button
 * and the ops console.
 */

export type ReleaseChannel = "canary" | "stable";

export interface HermesRelease {
  id: string;
  image_repo: string;
  version: string;
  digest: string;
  channel: ReleaseChannel;
  rollout_percent: number;
  pilot_instance_ids: string[];
  halted: boolean;
  halted_reason: string | null;
  halted_at: string | null;
  halted_by: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  promoted_at: string | null;
  updated_at: string;
}

export const RELEASE_COLUMNS =
  "id, image_repo, version, digest, channel, rollout_percent, pilot_instance_ids, halted, halted_reason, halted_at, halted_by, notes, created_by, created_at, promoted_at, updated_at";

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Repository of an image reference, without tag or digest:
 * `ghcr.io/o/n:stable` and `ghcr.io/o/n@sha256:...` both give `ghcr.io/o/n`.
 * A registry port (`host:5000/n`) is kept; only a tag on the last path segment
 * is stripped.
 */
export function imageRepoOf(ref: string): string {
  const trimmed = ref.trim();
  const at = trimmed.indexOf("@");
  const withoutDigest = at >= 0 ? trimmed.slice(0, at) : trimmed;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

/** `repo@sha256:...`, the only image reference form boxes are given. */
export function releaseImageRef(release: Pick<HermesRelease, "image_repo" | "digest">): string {
  return `${release.image_repo}@${release.digest}`;
}

/**
 * Rollout position of a box for a release, 0 (inclusive) to 100 (exclusive).
 * Salted by the release so the same boxes are not always first in line, and
 * stable per (release, box) so a box admitted at 10% stays admitted at 100%.
 */
export function rolloutBucket(releaseId: string, instanceId: string): number {
  const hash = createHash("sha256").update(`${releaseId}:${instanceId}`).digest();
  return (hash.readUInt32BE(0) % 10_000) / 100;
}

export interface ReleaseSubject {
  instanceId: string;
  channel: ReleaseChannel;
}

/** Whether the release is currently offered to this box. */
export function isReleaseEligible(release: HermesRelease, subject: ReleaseSubject): boolean {
  if (release.halted) return false;
  // Registered but never promoted: nobody is offered it yet.
  if (!release.promoted_at) return false;
  if (subject.channel === "canary") return true;
  if (release.channel !== "stable") return false;
  if (release.pilot_instance_ids.includes(subject.instanceId)) return true;
  return rolloutBucket(release.id, subject.instanceId) < release.rollout_percent;
}

/** Releases are ordered by registration time: the newest build is the newest release. */
function releaseOrderKey(release: HermesRelease): number {
  return Date.parse(release.created_at) || 0;
}

/**
 * The release a box should run: the newest eligible release of its image
 * repository, or null when none is offered. Releases of other repositories are
 * ignored: a box keeps the runtime its compose already uses.
 */
export function resolveTargetRelease(
  releases: readonly HermesRelease[],
  subject: ReleaseSubject & { imageRepo: string }
): HermesRelease | null {
  const eligible = releases
    .filter((release) => release.image_repo === subject.imageRepo)
    .filter((release) => isReleaseEligible(release, subject))
    .sort((a, b) => releaseOrderKey(b) - releaseOrderKey(a));
  return eligible[0] ?? null;
}

export type UpdateDirection = "none" | "upgrade" | "rollback" | "unknown_current";

export interface UpdateDecision {
  target: HermesRelease | null;
  direction: UpdateDirection;
  /** An automated sweep (roller, cron) should move the box to the target. */
  autoMove: boolean;
  /** The console shows "Update available" for this box. */
  updateAvailable: boolean;
}

/**
 * Compare the box's reported digest with its target.
 *
 * Automated paths only move a box forward, or back off a halted release. A
 * box on a release newer than its target (a pilot box after the ladder was
 * walked back, say) is left alone unless that release is halted; a user's
 * explicit Update always proceeds to the target.
 */
export function decideUpdate(
  releases: readonly HermesRelease[],
  subject: ReleaseSubject & { imageRepo: string; currentDigest: string | null }
): UpdateDecision {
  const target = resolveTargetRelease(releases, subject);
  if (!target) return { target: null, direction: "none", autoMove: false, updateAvailable: false };
  if (subject.currentDigest === target.digest) {
    return { target, direction: "none", autoMove: false, updateAvailable: false };
  }
  if (!subject.currentDigest) {
    return { target, direction: "unknown_current", autoMove: true, updateAvailable: true };
  }
  const current = releases.find(
    (release) => release.image_repo === subject.imageRepo && release.digest === subject.currentDigest
  );
  if (!current) {
    // A digest the registry has never seen (a legacy :stable pull): bring it
    // onto a registered release.
    return { target, direction: "unknown_current", autoMove: true, updateAvailable: true };
  }
  if (current.halted) {
    return { target, direction: "rollback", autoMove: true, updateAvailable: true };
  }
  const forward = releaseOrderKey(target) > releaseOrderKey(current);
  return {
    target,
    direction: forward ? "upgrade" : "rollback",
    autoMove: forward,
    updateAvailable: true,
  };
}

// ── Halt policy ─────────────────────────────────────────────────────────

export interface ReleaseOutcomeCounts {
  /** Distinct boxes whose last outcome on this release was a success. */
  succeededBoxes: number;
  /** Distinct boxes with a failed, rolled-back or paused outcome on it. */
  failedBoxes: number;
}

/** Boxes that must report before a failure ratio means anything. */
export const HALT_MIN_REPORTING_BOXES = 3;
/** Failure share of reporting boxes that halts a release once enough reported. */
export const HALT_FAILURE_RATIO = 0.2;
/** Failures that halt a release regardless of ratio once at least this many boxes failed. */
export const HALT_ABSOLUTE_FAILED_BOXES = 3;

/**
 * Whether a release should be halted automatically. A release being tried on
 * one or two boxes (the canary or pilot stage) halts on the first failure,
 * because the stage exists to catch exactly that. Wider rollouts halt on a
 * failure ratio, or on a fixed number of failed boxes.
 */
export function shouldHaltRelease(counts: ReleaseOutcomeCounts): { halt: boolean; reason: string } {
  const { failedBoxes, succeededBoxes } = counts;
  const reporting = failedBoxes + succeededBoxes;
  if (failedBoxes === 0) return { halt: false, reason: "no failures" };
  if (reporting < HALT_MIN_REPORTING_BOXES) {
    return {
      halt: true,
      reason: `${failedBoxes} of ${reporting} reporting boxes failed during the canary/pilot stage`,
    };
  }
  if (failedBoxes >= HALT_ABSOLUTE_FAILED_BOXES) {
    return { halt: true, reason: `${failedBoxes} boxes failed this release` };
  }
  if (failedBoxes / reporting >= HALT_FAILURE_RATIO) {
    return {
      halt: true,
      reason: `${failedBoxes} of ${reporting} reporting boxes failed (${Math.round((failedBoxes / reporting) * 100)}%)`,
    };
  }
  return { halt: false, reason: "below halt threshold" };
}

// ── Promotion ladder ────────────────────────────────────────────────────

export type ReleaseStage = "registered" | "canary" | "pilot" | "ten_percent" | "full";

export const RELEASE_STAGES: readonly ReleaseStage[] = [
  "registered",
  "canary",
  "pilot",
  "ten_percent",
  "full",
];

/** Where a release is on the ladder, from its stored fields. */
export function releaseStage(
  release: Pick<HermesRelease, "channel" | "rollout_percent" | "pilot_instance_ids" | "promoted_at">
): ReleaseStage {
  if (release.channel === "canary") return release.promoted_at ? "canary" : "registered";
  if (release.rollout_percent >= 100) return "full";
  if (release.rollout_percent > 0) return "ten_percent";
  return "pilot";
}

export function nextStage(stage: ReleaseStage): ReleaseStage | null {
  const index = RELEASE_STAGES.indexOf(stage);
  return index >= 0 && index < RELEASE_STAGES.length - 1 ? RELEASE_STAGES[index + 1] : null;
}

export interface StagePatch {
  channel: ReleaseChannel;
  rollout_percent: number;
  pilot_instance_ids?: string[];
  promoted_at: string;
}

export const TEN_PERCENT = 10;

/**
 * Fields to store for a stage. The pilot stage needs the one box chosen; the
 * ladder only moves one rung at a time so a release cannot skip its canary.
 */
export function stagePatch(
  from: ReleaseStage,
  to: ReleaseStage,
  options: { pilotInstanceId?: string; now?: string } = {}
): StagePatch {
  const now = options.now ?? new Date().toISOString();
  if (nextStage(from) !== to) {
    throw new Error(`A release moves one stage at a time: ${from} cannot go to ${to}.`);
  }
  switch (to) {
    case "canary":
      return { channel: "canary", rollout_percent: 0, promoted_at: now };
    case "pilot":
      if (!options.pilotInstanceId) throw new Error("The pilot stage needs the box to try it on.");
      return {
        channel: "stable",
        rollout_percent: 0,
        pilot_instance_ids: [options.pilotInstanceId],
        promoted_at: now,
      };
    case "ten_percent":
      return { channel: "stable", rollout_percent: TEN_PERCENT, promoted_at: now };
    case "full":
      return { channel: "stable", rollout_percent: 100, promoted_at: now };
    default:
      throw new Error(`Cannot promote into ${to}.`);
  }
}
