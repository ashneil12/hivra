import {
  createAgent,
  findHivraLaunchReceipt,
  HivraLaunchCorrectableError,
  HivraLaunchInProgressError,
  HivraLaunchRejectedError,
  type CreateAgentInput,
  type HivraAgent,
} from "@/lib/hivra/agent-api";
import type { AgentDeploymentDestination } from "@/lib/hivra/agent-placement";
import { PROFILE_DETAILS, type LaunchDraft } from "./contracts";

type ReceiptBearingCreateInput = CreateAgentInput & { launchRequestId: string };

// The launch route has a 180-second execution budget. Keep observing the
// owner-bound receipt through that whole admission window, plus a small final
// propagation margin, without ever resubmitting the POST.
const RECEIPT_RECONCILIATION_MS = 195_000;
const RECEIPT_POLL_MS = 750;

type SubmissionOutcome =
  | { state: "accepted"; agent: HivraAgent }
  | { state: "failed"; error: unknown };

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

/** The provisioning POST can keep doing exact host-side confirmation after its
 * durable receipt already names the new computer. Reconcile that receipt in
 * parallel so the launch screen advances as soon as acceptance is known. */
async function submitWithReceipt(input: ReceiptBearingCreateInput): Promise<HivraAgent> {
  const state: { settled: SubmissionOutcome | null } = { settled: null };
  const submission = createAgent(input).then<SubmissionOutcome, SubmissionOutcome>(
    agent => ({ state: "accepted", agent }),
    error => ({ state: "failed", error }),
  );
  void submission.then(outcome => { state.settled = outcome; });
  const currentSubmission = (): SubmissionOutcome | null => state.settled;

  const deadline = Date.now() + RECEIPT_RECONCILIATION_MS;
  while (Date.now() < deadline) {
    const current = currentSubmission();
    if (current?.state === "accepted") return current.agent;
    if (
      current?.state === "failed"
      && (current.error instanceof HivraLaunchRejectedError
        || current.error instanceof HivraLaunchCorrectableError)
    ) throw current.error;

    try {
      const receipt = await findHivraLaunchReceipt(input.launchRequestId);
      if (receipt?.state === "accepted") return receipt.agent;
    } catch (error) {
      if (error instanceof HivraLaunchRejectedError) throw error;
      // A temporarily unreadable/missing receipt is uncertainty, not proof
      // that the original request failed. The original POST remains in flight.
    }
    const afterReceipt = currentSubmission();
    if (afterReceipt?.state === "accepted") return afterReceipt.agent;
    if (currentSubmission() === null) {
      await Promise.race([submission, pause(RECEIPT_POLL_MS)]);
    } else {
      await pause(RECEIPT_POLL_MS);
    }
  }

  const outcome = currentSubmission();
  if (!outcome) {
    throw new HivraLaunchInProgressError(
      input.launchRequestId,
      "The launch is still being confirmed. Resume this same saved request instead of starting another computer.",
    );
  }
  if (outcome.state === "accepted") return outcome.agent;
  throw outcome.error;
}

export async function submitLaunchDraft(
  draft: LaunchDraft,
  deployment: AgentDeploymentDestination,
): Promise<HivraAgent> {
  if (!draft.profileId || !draft.name.trim()) throw new Error("Launch draft is incomplete.");
  const profile = PROFILE_DETAILS[draft.profileId];
  if (draft.profileId === "omarchy") {
    if (deployment.mode !== "hivra-managed") {
      throw new HivraLaunchCorrectableError("This prepared Canary computer currently runs on Hivra Cloud.", 409, "prepared_managed_only");
    }
    const response = await fetch("/api/hivra/prepared-computers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ profile: draft.profileId, name: draft.name.trim() }),
    });
    let payload: { success?: boolean; error?: string; data?: { agent?: HivraAgent } } | null = null;
    try { payload = await response.json(); } catch { /* handled below */ }
    if (!response.ok || payload?.success !== true || !payload.data?.agent) {
      const message = payload?.error || `Computer launch failed (${response.status})`;
      if (response.status >= 400 && response.status < 500) throw new HivraLaunchCorrectableError(message, response.status);
      throw new Error(message);
    }
    return payload.data.agent;
  }
  if (draft.profileId === "windows" && deployment.mode === "hivra-managed") {
    throw new HivraLaunchCorrectableError(
      "Hivra Cloud is unavailable for Windows without a real managed entitlement.",
      409,
      "managed_windows_entitlement_required",
    );
  }
  if (draft.profileId === "windows") {
    if (deployment.mode !== "self-managed" || !draft.windowsIsoVolume || !draft.windowsIsoEvidence || !draft.windowsRightsAttested) {
      throw new HivraLaunchCorrectableError("Choose a customer-owned ISO and confirm your Windows installation rights.", 400, "windows_setup_incomplete");
    }
    const response = await fetch("/api/hivra/windows/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        ...deployment,
        launchRequestId: draft.launchRequestId,
        name: draft.name.trim(),
        isoVolume: draft.windowsIsoVolume,
        mediaEvidence: draft.windowsIsoEvidence,
        mediaSource: draft.windowsIsoSource,
        cpu: draft.resources.cpu,
        ram: draft.resources.ram,
        diskGb: 64,
        rightsAttested: true,
        termsVersion: "windows-byo-iso-v1",
      }),
    });
    let payload: { success?: boolean; error?: string; code?: string; data?: { agent?: HivraAgent } } | null = null;
    try { payload = await response.json(); } catch { /* handled below */ }
    if (!response.ok || payload?.success !== true || !payload.data?.agent) {
      const message = payload?.error || `Windows setup failed (${response.status})`;
      if (payload?.code === "provision_uncertain" || response.status >= 500) {
        throw new HivraLaunchInProgressError(draft.launchRequestId, message);
      }
      throw new HivraLaunchCorrectableError(message, response.status, payload?.code);
    }
    return payload.data.agent;
  }
  if (draft.profileId === "linux-terminal") {
    if (deployment.mode !== "self-managed") {
      throw new HivraLaunchCorrectableError("Linux Sandbox requires a compatible gVisor host you connected.", 409, "gvisor_self_managed_only");
    }
    return submitWithReceipt({
      type: "linux-terminal",
      computerProfile: "linux-terminal",
      name: draft.name.trim(),
      cpu: draft.resources.cpu,
      ram: draft.resources.ram,
      maximumCpu: draft.resources.maximumCpu ?? draft.resources.cpu,
      maximumRam: draft.resources.maximumRam ?? draft.resources.ram,
      browser: false,
      deployment,
      launchRequestId: draft.launchRequestId,
    });
  }
  const input: ReceiptBearingCreateInput = {
    type: draft.profileId === "codex" ? "codex" : "linux-desktop",
    ...(draft.profileId === "ubuntu-desktop"
      ? { computerProfile: draft.profileId }
      : {}),
    name: draft.name.trim(),
    cpu: draft.resources.cpu,
    ram: draft.resources.ram,
    maximumCpu: draft.resources.maximumCpu,
    maximumRam: draft.resources.maximumRam,
    // Same flag the legacy welcome launch sends; false keeps Codex at its base floor.
    browser: draft.profileId === "codex" && draft.browser,
    deployment,
    launchRequestId: draft.launchRequestId,
  };
  return submitWithReceipt(input);
}

export function launchResultHref(draft: LaunchDraft, agentId: string): string {
  if (draft.profileId === "linux-terminal") return `/dashboard/agent/${encodeURIComponent(agentId)}?tab=manage`;
  if (draft.profileId && PROFILE_DETAILS[draft.profileId].resourceKind === "computer") {
    // The launch operation installs the desktop. Opening its result must not
    // request a second installation (or bypass explicit preparation holds).
    return `/dashboard/agent/${encodeURIComponent(agentId)}?tab=desktop`;
  }
  return `/dashboard/agent/${encodeURIComponent(agentId)}?welcome=1&tab=terminal`;
}
