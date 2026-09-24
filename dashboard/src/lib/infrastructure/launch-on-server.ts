import { targetSupportsCatalogRuntime } from "@/lib/hivra/agent-placement";
import {
  buildLaunchSetupHref,
  parsePortableLaunchResourceId,
  type PortableLaunchResourceId,
} from "@/lib/hivra/launch-navigation";
import { PROFILE_DETAILS, type LaunchDraft, type LaunchProfileId } from "@/lib/launch/contracts";

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
// the owner-scoped target and checks it again before anything starts.

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
  // A finished launch, or one with nothing chosen yet, is not pending. Nor is
  // one already sent: its server was fixed when it was submitted, and another
  // server can't take it over. Omarchy opens a prepared computer and never
  // runs on the owner's own server.
  if (!draft?.profileId || draft.profileId === "omarchy"
    || draft.launchState === "accepted" || draft.launchState === "submitting" || draft.launchState === "uncertain") {
    return null;
  }
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

export function isLaunchReadyTarget(target: DeploymentTargetDto): boolean {
  return target.status === "ready" && target.capabilities.launchReady === true;
}

/** The launch action for a saved, ready deployment target, or null when the
 * saved evidence does not say it is ready. */
export function launchOnDeploymentTarget(
  target: DeploymentTargetDto | null | undefined,
  pending: PendingLaunch | null,
): LaunchOnServerAction | null {
  if (!target || !isLaunchReadyTarget(target)) return null;
  return actionFor(target.id, isGvisorDeploymentTarget(target) ? "gvisor" : "other", pending, (launch) => (
    launch.source === "handoff"
      ? targetSupportsLaunchResource(target, launch.resourceId)
      : targetSupportsProfile(target, launch.profileId)
  ));
}

/** The launch action for a Linux host whose gVisor check or setup just came
 * back ready. Only Linux Sandbox runs there. */
export function launchOnGvisorTarget(targetId: string, pending: PendingLaunch | null): LaunchOnServerAction {
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
