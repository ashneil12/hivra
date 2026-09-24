import { HIVRA_GVISOR_PREPARE_STAGES, isHivraGvisorPrepareStage } from "@/lib/hivra/gvisor-computer-contract";
import { tryAgainInMinutes } from "@/lib/retry-after-copy";

import { InfrastructureApiError } from "./client";
import { internalFailureRemediation } from "./remediation-copy";

// The review dialog names every step of a host setup before anything runs,
// and afterwards marks only what it observed: every step on success, or the
// steps before the one a failure reported. While setup runs Hivra can't see
// which step is current, so none is marked running.

export type HostPreparationEngine = "proxmox" | "gvisor";

export type HostPreparationStep = { id: string; label: string };

export const PROXMOX_PREPARATION_STEPS: readonly HostPreparationStep[] = [
  { id: "check", label: "Check root access, Proxmox, KVM, storage and the network" },
  { id: "tools", label: "Install Hivra's host tools" },
  { id: "image", label: "Download and verify the Ubuntu base image" },
  { id: "network", label: "Set up the private network agent computers use" },
  { id: "readiness", label: "Check the server is ready and save the result" },
];

export const GVISOR_PREPARATION_STEPS: readonly HostPreparationStep[] = [
  { id: "check", label: "Check the server still meets the requirements" },
  { id: "docker", label: "Install Docker and the tools setup needs" },
  { id: "download", label: "Download Hivra's pinned gVisor release and verify it" },
  { id: "install", label: "Install gVisor and connect it to Docker" },
  { id: "test", label: "Download the Linux Sandbox image and run a test sandbox" },
  { id: "readiness", label: "Check the server is ready and save the result" },
];

export function preparationSteps(engine: HostPreparationEngine): readonly HostPreparationStep[] {
  return engine === "proxmox" ? PROXMOX_PREPARATION_STEPS : GVISOR_PREPARATION_STEPS;
}

const GVISOR_STAGE_STEP: Record<(typeof HIVRA_GVISOR_PREPARE_STAGES)[number] | "readiness-check", string> = {
  "host-eligibility": "check",
  prerequisites: "docker",
  "bundle-download": "download",
  "bundle-checksum": "download",
  "bundle-validation": "download",
  // Both stop before anything is installed: gVisor already on the server
  // blocked the install step.
  "installed-adapter-check": "install",
  "installed-identity-check": "install",
  "asset-installation": "install",
  "runtime-registration": "install",
  "sidecar-validation": "install",
  "image-pull": "test",
  "sandbox-smoke-test": "test",
  "readiness-check": "readiness",
};

const GVISOR_STAGE_NEXT: Record<keyof typeof GVISOR_STAGE_STEP, string> = {
  "host-eligibility": "Inspect the server again to see what changed.",
  prerequisites: "The server couldn't install Docker from Ubuntu's package archive. Check that apt can reach it, then try again.",
  "bundle-download": "The server couldn't download gVisor from GitHub. Check that it can reach github.com over HTTPS, then try again.",
  "bundle-checksum": "The download didn't match the checksum of Hivra's pinned gVisor release, so nothing was installed from it. Try again. If it happens again, check for a proxy or firewall that changes downloads.",
  "bundle-validation": "Hivra's pinned gVisor release didn't contain the files Hivra expects, so nothing was installed from it. Your server isn't the cause. Try again later.",
  "installed-adapter-check": "This server has Linux Sandbox setup from another Hivra release. Hivra leaves it in place so Linux Sandbox computers made with it keep working, and reinstalling won't replace it. Use another server, or delete those computers and remove the old setup first.",
  "installed-identity-check": "This server already has gVisor, installed another way or at a different release, and Hivra left it in place. Reinstalling won't replace it. If nothing on the server uses it, remove it, then try again. Otherwise, use another server.",
  "asset-installation": "Check the server's free disk space, then try again.",
  "runtime-registration": "Docker didn't pick up gVisor after its settings reloaded. Restart Docker on the server, then try again.",
  "sidecar-validation": "The installed gVisor files didn't match the pinned release. Try again.",
  "image-pull": "The server couldn't download the Linux Sandbox image from Docker Hub. Check its network, then try again.",
  "sandbox-smoke-test": "The test sandbox didn't start. Try again.",
  "readiness-check": "Setup finished, but its final check didn't pass. Inspect the server again, then check readiness.",
};

const GVISOR_STAGES_NEEDING_SERVER_CHANGE: ReadonlySet<string> = new Set([
  "installed-adapter-check",
  "installed-identity-check",
]);

const PROXMOX_CAUSE_STEP: Record<string, string> = {
  root_required: "check",
  proxmox_version_unsupported: "check",
  kvm_unavailable: "check",
  storage_unavailable: "check",
  host_tools_missing: "check",
  network_conflict: "check",
  already_running: "check",
  image_download_failed: "image",
  network_setup_failed: "network",
};

const PROXMOX_CAUSE_NEXT: Record<string, string> = {
  root_required: "Edit the connection, set the SSH user to root, then review setup again.",
  proxmox_version_unsupported: "Upgrade the server to Proxmox VE 8 or 9, then try again.",
  kvm_unavailable: "Turn on virtualization so /dev/kvm exists on the server, then try again.",
  storage_unavailable: "In the Proxmox web UI, open Datacenter → Storage and enable a storage that allows Disk image content. Then try again.",
  host_tools_missing: "Install the standard Proxmox VE packages on the server, then try again.",
  network_conflict: "Hivra's private network, hivra0 on 10.251.20.0/24, clashes with a bridge or route already on this server. Free it, then try again.",
  network_setup_failed: "Try again. If it repeats, check the server's network settings for rules that replace Hivra's.",
  image_download_failed: "Check that the server can reach cloud-images.ubuntu.com over HTTPS, then try again.",
  already_running: "Wait for the other setup to finish, then check the server again.",
};

export type HostPreparationFailure = {
  title: string;
  detail: string;
  /** The step the failure reported, when it reported one. */
  failedStepId: string | null;
  /** False while a wait is required before trying again. */
  canRetryNow: boolean;
};

/** One plain cause and next step for a failed setup, from the fixed codes the
 * server returned. Raw host output is never shown. */
export function hostPreparationFailure(
  error: unknown,
  engine: HostPreparationEngine,
  name: string,
): HostPreparationFailure {
  if (!(error instanceof InfrastructureApiError)) {
    return {
      title: `${name} was not set up.`,
      detail: error instanceof Error && error.message ? error.message : internalFailureRemediation(),
      failedStepId: null,
      canRetryNow: true,
    };
  }
  if (error.code === "PREPARATION_FAILURES_LIMITED") {
    return {
      title: `Setup failed on ${name} several times in the last 15 minutes.`,
      detail: error.retryAfterSeconds !== null
        ? `${tryAgainInMinutes(error.retryAfterSeconds)} Fix what the last attempt reported first.`
        : "Wait a few minutes, then try again. Fix what the last attempt reported first.",
      failedStepId: null,
      canRetryNow: false,
    };
  }
  if (error.code === "PREPARATION_RATE_LIMITED" || error.status === 429) {
    return {
      title: `Setup ran on ${name} in the last 15 minutes.`,
      detail: error.retryAfterSeconds !== null
        ? tryAgainInMinutes(error.retryAfterSeconds)
        : "Wait a few minutes, then try again.",
      failedStepId: null,
      canRetryNow: false,
    };
  }
  if (error.code === "PREPARATION_IN_PROGRESS") {
    return {
      title: `Setup is already running on ${name}.`,
      detail: "Wait for it to finish, then check the server again.",
      failedStepId: null,
      canRetryNow: false,
    };
  }
  if (engine === "gvisor") {
    const stage = error.detail.stage;
    if (stage && (isHivraGvisorPrepareStage(stage) || stage === "readiness-check")) {
      const stepId = GVISOR_STAGE_STEP[stage];
      const index = GVISOR_PREPARATION_STEPS.findIndex((step) => step.id === stepId);
      return {
        title: `Setup stopped at step ${index + 1} of ${GVISOR_PREPARATION_STEPS.length}: ${GVISOR_PREPARATION_STEPS[index].label}.`,
        detail: GVISOR_STAGE_NEXT[stage],
        failedStepId: stepId,
        // Trying again can't get past gVisor that's already on the server.
        canRetryNow: !GVISOR_STAGES_NEEDING_SERVER_CHANGE.has(stage),
      };
    }
  } else {
    const cause = error.detail.cause;
    if (cause && PROXMOX_CAUSE_NEXT[cause]) {
      return {
        title: error.message,
        detail: PROXMOX_CAUSE_NEXT[cause],
        failedStepId: PROXMOX_CAUSE_STEP[cause] ?? null,
        canRetryNow: cause !== "already_running",
      };
    }
  }
  switch (error.code) {
    case "SSH_AUTHENTICATION_FAILED":
      return { title: `Hivra couldn't sign in to ${name}.`, detail: "Check the SSH user and key on the connection, then try again.", failedStepId: null, canRetryNow: true };
    case "SSH_CONNECTION_FAILED":
      return { title: `Hivra couldn't reach ${name} over SSH.`, detail: "Check the address, SSH port and firewall, then try again.", failedStepId: null, canRetryNow: true };
    case "SSH_HOST_KEY_MISMATCH":
      return { title: `${name}'s SSH identity changed.`, detail: "Confirm the server's fingerprint and update the connection before trying again.", failedStepId: null, canRetryNow: false };
    case "PREPARATION_SUPERSEDED":
      return { title: "The connection changed while setup was running.", detail: "Inspect the server again, then review setup.", failedStepId: null, canRetryNow: false };
    case "conflict":
      return { title: error.message, detail: "Wait for the other check or setup to finish, then try again.", failedStepId: null, canRetryNow: true };
    case "not_ready":
      return { title: error.message, detail: "Edit the connection, set the SSH user to root, then review setup again.", failedStepId: null, canRetryNow: false };
    default:
      return { title: error.message || `${name} was not set up.`, detail: internalFailureRemediation(), failedStepId: null, canRetryNow: true };
  }
}
