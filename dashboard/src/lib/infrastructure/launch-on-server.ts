import { targetSupportsCatalogRuntime } from "@/lib/hivra/agent-placement";
import {
  HIVRA_GVISOR_ADAPTER_VERSION,
  HIVRA_GVISOR_PREFLIGHT_TTL_MS,
} from "@/lib/hivra/gvisor-computer-contract";
import {
  buildLaunchSetupHref,
  parsePortableLaunchResourceId,
  type PortableLaunchResourceId,
} from "@/lib/hivra/launch-navigation";
import { PROFILE_DETAILS, type LaunchDraft, type LaunchProfileId } from "@/lib/launch/contracts";
import { isUnfinishedLaunchDraft } from "@/lib/launch/draft-store";

import {
  isGvisorDeploymentTarget,
  isProxmoxDeploymentTarget,
  type DeploymentTargetDto,
} from "./contracts";
import { PORTABLE_HIVRA_SUPPORTED_PROVIDER_VM_CATALOG_RUNTIME_IDS } from "./portable-provisioner-contract";

// Every ready server in Infrastructure ends in one primary action: open the
// launch journey with that server already chosen. When a launch is already
// under way and can use the server, the action continues it instead of
// starting over. This is navigation intent only; the launch journey reloads
// the owner-scoped target before anything starts.
//
// Readiness is what the server will accept right now, not only what was saved:
// a Linux Sandbox (gVisor) host's strict check authorizes a new sandbox for
// HIVRA_GVISOR_PREFLIGHT_TTL_MS (gvisor-computer-service executionAuthority),
// so its ready state and launch action end when that window does.

/** A launch the owner started before coming to Infrastructure. */
export type PendingLaunch =
  /** The unified launch journey's saved draft, in this browser tab. */
  | { source: "journey"; profileId: LaunchProfileId }
  /** A launch that sent the owner here with ?launch=<resource>. */
  | { source: "handoff"; resourceId: PortableLaunchResourceId; unified: boolean };

export type LaunchOnServerAction = {
  label: "Launch on this server" | "Continue launch";
  href: string;
};

export function pendingLaunchFrom(input: {
  launchParam: string | null;
  returnTo: string | null;
  draft: LaunchDraft | null;
}): PendingLaunch | null {
  const resourceId = parsePortableLaunchResourceId(input.launchParam);
  if (resourceId) {
    return { source: "handoff", resourceId, unified: input.returnTo === "unified-launch" };
  }
  const draft = input.draft;
  // Only a draft the owner started and hasn't sent is pending: a launch
  // already sent keeps the server it was sent to, and a finished one is done.
  // Omarchy opens a prepared computer and never runs on the owner's own
  // server.
  if (!isUnfinishedLaunchDraft(draft) || !draft.profileId || draft.profileId === "omarchy") return null;
  return { source: "journey", profileId: draft.profileId };
}

/** The same compatibility test the Infrastructure return banner uses. */
export function targetSupportsLaunchResource(
  target: DeploymentTargetDto,
  resourceId: PortableLaunchResourceId,
): boolean {
  return targetSupportsCatalogRuntime(target, resourceId)
    && (resourceId !== "linux-desktop" || isProxmoxDeploymentTarget(target))
    && (resourceId !== "linux-terminal" || isGvisorDeploymentTarget(target));
}

/** The same compatibility test the launch journey's destination uses. */
function targetSupportsProfile(target: DeploymentTargetDto, profileId: LaunchProfileId): boolean {
  const profile = PROFILE_DETAILS[profileId];
  return targetSupportsCatalogRuntime(target, profile.placementRuntimeId)
    && (profile.placementRuntimeId !== "linux-terminal" || isGvisorDeploymentTarget(target));
}

function continueHref(pending: PendingLaunch, targetId: string): string {
  return pending.source === "handoff"
    ? buildLaunchSetupHref(pending.resourceId, targetId, { unified: pending.unified })
    // No start=1: the journey keeps its saved draft and takes this server.
    : `/dashboard/launch?targetId=${encodeURIComponent(targetId)}`;
}

/** A fresh launch with the server chosen. A Linux Sandbox server can run only
 * Linux Sandbox, so that choice is made too. */
export function freshLaunchHref(targetId: string, placement: "gvisor" | "other"): string {
  const id = encodeURIComponent(targetId);
  return placement === "gvisor"
    ? `/dashboard/launch?kind=computer&profile=linux-terminal&start=1&targetId=${id}`
    : `/dashboard/launch?start=1&targetId=${id}`;
}

function actionFor(
  targetId: string,
  placement: "gvisor" | "other",
  pending: PendingLaunch | null,
  supports: (pending: PendingLaunch) => boolean,
): LaunchOnServerAction {
  return pending && supports(pending)
    ? { label: "Continue launch", href: continueHref(pending, targetId) }
    : { label: "Launch on this server", href: freshLaunchHref(targetId, placement) };
}

/** The saved evidence says ready. For a gVisor host this alone is not enough
 * to launch; see launchReadyUntil. */
export function hasReadyEvidence(target: DeploymentTargetDto): boolean {
  return target.status === "ready" && target.capabilities.launchReady === true;
}

/**
 * When a saved target stops authorizing a launch, in epoch milliseconds.
 * Proxmox and cloud-server readiness doesn't lapse with time (Infinity). A
 * gVisor host's does: the server accepts a new sandbox only within
 * HIVRA_GVISOR_PREFLIGHT_TTL_MS of the last strict check, and only for the
 * adapter this Hivra release installs. A target that isn't ready has already
 * lapsed (-Infinity).
 *
 * Only the deadline is compared with the browser's clock, never the check
 * time itself, so a browser clock a little behind the server's can't make a
 * check that just passed look like it came from the future.
 */
export function launchReadyUntil(target: DeploymentTargetDto): number {
  if (!hasReadyEvidence(target)) return -Infinity;
  if (!isGvisorDeploymentTarget(target)) return Infinity;
  if (target.capabilities.adapter.version !== HIVRA_GVISOR_ADAPTER_VERSION) return -Infinity;
  const checkedAt = target.lastPreflightAt ? Date.parse(target.lastPreflightAt) : Number.NaN;
  return Number.isFinite(checkedAt) ? checkedAt + HIVRA_GVISOR_PREFLIGHT_TTL_MS : -Infinity;
}

/** A gVisor host whose Linux Sandbox setup came from an older Hivra release.
 * Its readiness has lapsed for that reason, not because of the check's age. */
export function gvisorAdapterOutdated(target: DeploymentTargetDto): boolean {
  return hasReadyEvidence(target) && isGvisorDeploymentTarget(target)
    && target.capabilities.adapter.version !== HIVRA_GVISOR_ADAPTER_VERSION;
}

/** When a strict gVisor check that passed in this browser stops authorizing
 * a launch. */
export function gvisorCheckReadyUntil(checkedAt: number): number {
  return checkedAt + HIVRA_GVISOR_PREFLIGHT_TTL_MS;
}

export function isLaunchReadyTarget(target: DeploymentTargetDto, now: number): boolean {
  return now < launchReadyUntil(target);
}

/** The ids of the targets that can launch at `now`, as a stable key. */
export function launchReadyTargetKey(targets: readonly DeploymentTargetDto[], now: number): string {
  return targets.filter((target) => isLaunchReadyTarget(target, now)).map((target) => target.id).join(",");
}

/** The next moment any of these targets' readiness lapses, or null. */
export function nextLaunchReadinessChange(targets: readonly DeploymentTargetDto[], now: number): number | null {
  let next: number | null = null;
  for (const target of targets) {
    const until = launchReadyUntil(target);
    if (Number.isFinite(until) && until > now && (next === null || until < next)) next = until;
  }
  return next;
}

/** The launch action for a saved target. Offer it only while the target can
 * launch: before launchReadyUntil(target) (useTargetLaunchAction does this). */
export function launchActionForReadyTarget(
  target: DeploymentTargetDto,
  pending: PendingLaunch | null,
): LaunchOnServerAction {
  return actionFor(target.id, isGvisorDeploymentTarget(target) ? "gvisor" : "other", pending, (launch) => (
    launch.source === "handoff"
      ? targetSupportsLaunchResource(target, launch.resourceId)
      : targetSupportsProfile(target, launch.profileId)
  ));
}

/** A strict gVisor check (or setup, which ends with one) that passed in this
 * browser, with the browser's time when its answer arrived. */
export type GvisorReadinessCheck = { targetId: string; checkedAt: number };

/** The launch action for a Linux host whose gVisor check or setup just came
 * back ready. Only Linux Sandbox runs there. Offer it only before
 * gvisorCheckReadyUntil(checkedAt) (useGvisorCheckLaunchAction does this). */
export function launchActionForGvisorCheck(targetId: string, pending: PendingLaunch | null): LaunchOnServerAction {
  return actionFor(targetId, "gvisor", pending, (launch) => (
    launch.source === "handoff" ? launch.resourceId === "linux-terminal" : launch.profileId === "linux-terminal"
  ));
}

function providerVmRunsRuntime(runtimeId: string): boolean {
  return runtimeId === "linux-desktop"
    || (PORTABLE_HIVRA_SUPPORTED_PROVIDER_VM_CATALOG_RUNTIME_IDS as readonly string[]).includes(runtimeId);
}

/** The launch action for a ready Hivra-created cloud server, known here only
 * by its target id and the runtimes its setup bundle supports. */
export function launchOnProviderServer(targetId: string, pending: PendingLaunch | null): LaunchOnServerAction {
  return actionFor(targetId, "other", pending, (launch) => providerVmRunsRuntime(
    launch.source === "handoff" ? launch.resourceId : PROFILE_DETAILS[launch.profileId].placementRuntimeId,
  ));
}
