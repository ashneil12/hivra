import { recommendedResourceEnvelope } from "./resource-envelope";

export const LAUNCH_DRAFT_SCHEMA_VERSION = 1 as const;

export type LaunchStage = "type" | "profile" | "capacity" | "review" | "launch";
export type LaunchResourceKind = "agent" | "computer";
export type LaunchProfileId = "codex" | "ubuntu-desktop" | "linux-terminal" | "omarchy" | "windows";
export type LaunchState = "idle" | "submitting" | "uncertain" | "accepted" | "failed";

export type LaunchResources = {
  /** Guaranteed allocation charged to capacity. */
  cpu: number;
  ram: number;
  /** Hard burst ceilings. Optional only for legacy persisted drafts. */
  maximumCpu?: number;
  maximumRam?: number;
  source: "recommended" | "custom";
};
export type WindowsIsoEvidence = {
  sizeBytes: number;
  modifiedAtSeconds: number;
  fileIdentitySha256: string;
};
export type WindowsIsoSource = "unknown" | "windows-11" | "windows-server-evaluation";
export type WindowsIsoDownloadDraft = {
  taskId: string;
  connectionId: string;
  targetId: string;
  expectedConnectionRevision: number;
  source: Exclude<WindowsIsoSource, "unknown">;
  storage: string;
  filename: string;
  state: "queued" | "running";
};

export type LaunchCapacityChoice =
  | { mode: "hivra-managed"; targetId: null }
  | { mode: "self-managed"; targetId: string | null };

/** Secret-free, immutable placement authority captured at the first submit.
 * An uncertain replay must send this exact snapshot even if live capacity
 * evidence or plan availability changes before the browser returns. */
export type LaunchDeploymentSnapshot =
  | { mode: "hivra-managed" }
  | {
      mode: "self-managed";
      connectionId: string;
      targetId: string;
      expectedConnectionRevision: number;
    };

type LaunchResult = {
  id: string;
  name: string;
  status: string;
};

export type LaunchDraft = {
  schemaVersion: typeof LAUNCH_DRAFT_SCHEMA_VERSION;
  launchRequestId: string;
  stage: LaunchStage;
  resourceKind: LaunchResourceKind | null;
  profileId: LaunchProfileId | null;
  name: string;
  resources: LaunchResources;
  windowsIsoVolume: string | null;
  windowsIsoEvidence: WindowsIsoEvidence | null;
  windowsIsoSource: WindowsIsoSource;
  windowsIsoDownload: WindowsIsoDownloadDraft | null;
  windowsRightsAttested: boolean;
  /** Codex's browser sidecar. Always false for profiles without one. */
  browser: boolean;
  /** "recommended" follows the plan-derived default until the owner chooses. */
  browserSource: "recommended" | "custom";
  capacity: LaunchCapacityChoice;
  submittedDeployment: LaunchDeploymentSnapshot | null;
  launchState: LaunchState;
  result: LaunchResult | null;
  error: string | null;
};

const LAUNCH_STAGES: readonly LaunchStage[] = [
  "type",
  "profile",
  "capacity",
  "review",
  "launch",
];

export const PROFILE_DETAILS: Record<LaunchProfileId, {
  resourceKind: LaunchResourceKind;
  name: string;
  runtimeId: "codex" | "linux-desktop" | "linux-terminal";
  /** Compatibility evidence required from the exact selected launch target.
   * This is deliberately separate from the guest runtime sent at launch: a
   * generic Linux desktop adapter is not evidence of Windows capability. */
  placementRuntimeId: "codex" | "linux-desktop" | "linux-terminal" | "windows-installer";
  managedCapacity: "plan" | "entitlement-required" | "self-managed-only";
  defaultName: string;
  recommended: LaunchResources;
  /** Selectable sizes; the journey hides those below the active floor. */
  cpuOptions: readonly number[];
  ramOptions: readonly number[];
}> = {
  codex: {
    resourceKind: "agent",
    name: "Codex",
    runtimeId: "codex",
    placementRuntimeId: "codex",
    managedCapacity: "plan",
    defaultName: "MY_CODEX_AGENT",
    recommended: { ...recommendedResourceEnvelope("codex"), source: "recommended" },
    // The lower sizes are reachable only with the browser sidecar off.
    cpuOptions: [0.5, 1, 1.5, 2, 4, 8],
    ramOptions: [1, 2, 3, 4, 8, 16],
  },
  "ubuntu-desktop": {
    resourceKind: "computer",
    name: "Ubuntu Desktop",
    runtimeId: "linux-desktop",
    placementRuntimeId: "linux-desktop",
    managedCapacity: "plan",
    defaultName: "MY_UBUNTU_DESKTOP",
    recommended: { ...recommendedResourceEnvelope("ubuntu-desktop"), source: "recommended" },
    cpuOptions: [2, 4, 8],
    ramOptions: [4, 8, 16],
  },
  "linux-terminal": {
    resourceKind: "computer",
    name: "Linux Sandbox",
    runtimeId: "linux-terminal",
    placementRuntimeId: "linux-terminal",
    managedCapacity: "self-managed-only",
    defaultName: "MY_LINUX_SANDBOX",
    recommended: { ...recommendedResourceEnvelope("linux-terminal"), source: "recommended" },
    cpuOptions: [0.5, 1, 2, 4],
    ramOptions: [1, 2, 4, 8],
  },
  omarchy: {
    resourceKind: "computer",
    name: "Omarchy",
    runtimeId: "linux-desktop",
    placementRuntimeId: "linux-desktop",
    managedCapacity: "plan",
    defaultName: "MY_OMARCHY_DESKTOP",
    recommended: { ...recommendedResourceEnvelope("omarchy"), source: "recommended" },
    cpuOptions: [4],
    ramOptions: [8],
  },
  windows: {
    resourceKind: "computer",
    name: "Windows",
    runtimeId: "linux-desktop",
    placementRuntimeId: "windows-installer",
    // A future managed provider adapter must replace this with a real,
    // account-bound entitlement check. UI acknowledgement is never authority.
    managedCapacity: "entitlement-required",
    defaultName: "MY_WINDOWS_DESKTOP",
    recommended: { ...recommendedResourceEnvelope("windows"), source: "recommended" },
    cpuOptions: [4],
    ramOptions: [8],
  },
};

export function stageNumber(stage: LaunchStage): number {
  return LAUNCH_STAGES.indexOf(stage) + 1;
}
