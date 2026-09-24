import { recommendedResourceEnvelope } from "./resource-envelope";

export const LAUNCH_DRAFT_SCHEMA_VERSION = 1 as const;

/** Choose what to launch, review Hivra's plan for it, review the exact
 * changes, then launch. Drafts saved before the Choose screen merged the
 * type and profile screens are restored by the draft store. */
export type LaunchStage = "choose" | "plan" | "review" | "launch";
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
  /** The owner's own Codex size from before they turned the browser on and it
   * raised that size to the browser floor. Turning the browser off gives it
   * back while the raised size is unchanged. */
  browserRaisedFrom: LaunchResources | null;
  capacity: LaunchCapacityChoice;
  submittedDeployment: LaunchDeploymentSnapshot | null;
  launchState: LaunchState;
  result: LaunchResult | null;
  error: string | null;
};

export const PROFILE_DETAILS: Record<LaunchProfileId, {
  resourceKind: LaunchResourceKind;
  name: string;
  runtimeId: "codex" | "linux-desktop" | "linux-terminal";
  /** Compatibility evidence required from the exact selected launch target.
   * This is deliberately separate from the guest runtime sent at launch: a
   * generic Linux desktop adapter is not evidence of Windows capability. */
  placementRuntimeId: "codex" | "linux-desktop" | "linux-terminal" | "windows-installer";
  managedCapacity: "plan" | "entitlement-required" | "self-managed-only";
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
    recommended: { ...recommendedResourceEnvelope("windows"), source: "recommended" },
    cpuOptions: [4],
    ramOptions: [8],
  },
};

export const LAUNCH_PROFILE_IDS: readonly LaunchProfileId[] = ["codex", "ubuntu-desktop", "linux-terminal", "omarchy", "windows"];

export function isLaunchProfileId(value: unknown): value is LaunchProfileId {
  return typeof value === "string" && (LAUNCH_PROFILE_IDS as readonly string[]).includes(value);
}

/** Launch names are 1-60 characters on every launch route. */
export const LAUNCH_NAME_MAX_LENGTH = 60;
