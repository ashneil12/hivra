import { recommendedResourceEnvelope } from "./resource-envelope";

export const LAUNCH_DRAFT_SCHEMA_VERSION = 1 as const;

/** Choose what to launch, review Hivra's plan for it, review the exact
 * changes, then launch. Drafts saved before the Choose screen merged the
 * type and profile screens are restored by the draft store. */
export type LaunchStage = "choose" | "plan" | "review" | "launch";
export type LaunchResourceKind = "agent" | "computer";
export type LaunchAgentProfileId = "claude-code" | "codex" | "hermes" | "openclaw" | "agent-zero" | "aeon";
export type LaunchComputerProfileId = "ubuntu-desktop" | "linux-terminal" | "omarchy" | "windows";
export type LaunchProfileId = LaunchAgentProfileId | LaunchComputerProfileId;
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

/** How the agent reaches a model. "native" is the runtime's own sign-in or
 * setup inside it after it opens; "api-key" sends the owner's own provider
 * key to the agent's computer; "credits" bills Hivra credits. */
export type LaunchModelAccessMode = "native" | "api-key" | "credits";

/** Secret-free model choice. A pasted key never enters the draft: it lives
 * only in the page's memory for the launch it was typed into. */
export type LaunchModelAccess = {
  mode: LaunchModelAccessMode;
  /** "recommended" follows Hivra's default until the owner chooses. */
  source: "recommended" | "custom";
  /** Provider the key belongs to (always Venice outside Hermes). */
  provider: string;
  /** "" means the provider's first listed model. */
  model: string;
  keySource: "saved" | "paste";
  /** The saved Vault key chosen for this launch. */
  vaultKeyId: string | null;
  /** The owner ticked "Send this key to <name>'s computer" for this launch. */
  sendSavedKey: boolean;
  /** Save a pasted key in the Vault before launching. Off until the owner
   * ticks it: the Vault keeps one key per provider, so saving replaces one. */
  saveKey: boolean;
  walletType: "card" | "hermesos";
  /** Hermes custom OpenAI-compatible endpoint (custom_llm only). */
  baseUrl: string;
};

/** A saved template a draft starts from. */
export type LaunchDraftTemplate = { id: string; name: string | null };

/** A next step a correctable launch error can offer beside its message. */
export type LaunchErrorAction =
  | { kind: "verify-card" }
  | { kind: "open"; label: string; href: string };

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
  modelAccess: LaunchModelAccess;
  /** Hermes: the owner ticked "Send my saved Honcho key to <name>'s
   * computer" for this launch. Never pre-ticked. */
  sendMemoryKey: boolean;
  /** The saved template this launch starts from, for the draft's profile.
   * Only its id and name: the server applies the rest at launch. */
  template: LaunchDraftTemplate | null;
  submittedDeployment: LaunchDeploymentSnapshot | null;
  /** When the first launch request was sent. Receipt-free lanes use it to
   * recognise the computer that request created. */
  submittedAt: string | null;
  launchState: LaunchState;
  result: LaunchResult | null;
  error: string | null;
  errorAction: LaunchErrorAction | null;
};

export const DEFAULT_MODEL_ACCESS: LaunchModelAccess = {
  mode: "native",
  source: "recommended",
  provider: "venice",
  model: "",
  keySource: "paste",
  vaultKeyId: null,
  sendSavedKey: false,
  saveKey: false,
  walletType: "card",
  baseUrl: "",
};

/** Where a runtime's launch request goes. Hermes keeps its own instance lane;
 * every other runtime uses the Hivra agent launch. */
export type LaunchLane = "hivra-agent" | "hermes-instance" | "prepared-computer" | "windows-installer";

export const PROFILE_DETAILS: Record<LaunchProfileId, {
  resourceKind: LaunchResourceKind;
  name: string;
  runtimeId: "codex" | "claude-code" | "hermes" | "openclaw" | "agent-zero" | "aeon" | "linux-desktop" | "linux-terminal";
  /** Compatibility evidence required from the exact selected launch target.
   * This is deliberately separate from the guest runtime sent at launch: a
   * generic Linux desktop adapter is not evidence of Windows capability. */
  placementRuntimeId: "codex" | "claude-code" | "hermes" | "openclaw" | "agent-zero" | "aeon"
    | "linux-desktop" | "linux-terminal" | "windows-installer";
  managedCapacity: "plan" | "entitlement-required" | "self-managed-only";
  /** Whether a server the owner connected can run it. Hermes runs on Hivra
   * Cloud only. */
  ownServer: boolean;
  lane: LaunchLane;
  /** The optional browser on its computer. "follows-destination" starts on
   * when the place it runs holds it; "opt-in" starts off until the owner
   * turns it on, as its setup form always did. */
  browser: "none" | "follows-destination" | "opt-in";
  /** "burst" reserves a size and may use more up to a maximum; "pinned"
   * always keeps its size and never uses more (the launch sends no maxima);
   * "fixed" has one size only. */
  sizing: "burst" | "pinned" | "fixed";
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
    ownServer: true,
    lane: "hivra-agent",
    browser: "follows-destination",
    sizing: "burst",
    recommended: { ...recommendedResourceEnvelope("codex"), source: "recommended" },
    // The lower sizes are reachable only with the browser sidecar off.
    cpuOptions: [0.5, 1, 1.5, 2, 4, 8],
    ramOptions: [1, 2, 3, 4, 8, 16],
  },
  "claude-code": {
    resourceKind: "agent",
    name: "Claude Code",
    runtimeId: "claude-code",
    placementRuntimeId: "claude-code",
    managedCapacity: "plan",
    ownServer: true,
    lane: "hivra-agent",
    browser: "follows-destination",
    sizing: "pinned",
    recommended: { ...recommendedResourceEnvelope("claude-code"), source: "recommended" },
    cpuOptions: [0.5, 1, 2, 4, 8],
    ramOptions: [1, 2, 4, 8, 16],
  },
  hermes: {
    resourceKind: "agent",
    name: "Hermes",
    runtimeId: "hermes",
    placementRuntimeId: "hermes",
    managedCapacity: "plan",
    ownServer: false,
    lane: "hermes-instance",
    browser: "none",
    sizing: "pinned",
    recommended: { ...recommendedResourceEnvelope("hermes"), source: "recommended" },
    cpuOptions: [0.5, 1, 2, 4, 8],
    ramOptions: [1, 2, 4, 8, 16],
  },
  openclaw: {
    resourceKind: "agent",
    name: "OpenClaw",
    runtimeId: "openclaw",
    placementRuntimeId: "openclaw",
    managedCapacity: "plan",
    ownServer: true,
    lane: "hivra-agent",
    browser: "opt-in",
    sizing: "pinned",
    recommended: { ...recommendedResourceEnvelope("openclaw", { browser: false }), source: "recommended" },
    cpuOptions: [1, 2, 4, 8],
    ramOptions: [2, 4, 8, 16],
  },
  "agent-zero": {
    resourceKind: "agent",
    name: "Agent Zero",
    runtimeId: "agent-zero",
    placementRuntimeId: "agent-zero",
    managedCapacity: "plan",
    ownServer: true,
    lane: "hivra-agent",
    browser: "none",
    sizing: "pinned",
    recommended: { ...recommendedResourceEnvelope("agent-zero"), source: "recommended" },
    cpuOptions: [1, 2, 4, 8],
    ramOptions: [2, 4, 8, 16],
  },
  aeon: {
    resourceKind: "agent",
    name: "Aeon",
    runtimeId: "aeon",
    placementRuntimeId: "aeon",
    managedCapacity: "plan",
    ownServer: true,
    lane: "hivra-agent",
    browser: "none",
    // Aeon only hosts its dashboard here; its work runs on the owner's GitHub
    // Actions, so Hivra Cloud always gives it the same small computer.
    sizing: "fixed",
    recommended: { ...recommendedResourceEnvelope("aeon"), source: "recommended" },
    cpuOptions: [0.5, 1, 2, 4],
    ramOptions: [1, 2, 4, 8],
  },
  "ubuntu-desktop": {
    resourceKind: "computer",
    name: "Ubuntu Desktop",
    runtimeId: "linux-desktop",
    placementRuntimeId: "linux-desktop",
    managedCapacity: "plan",
    ownServer: true,
    lane: "hivra-agent",
    browser: "none",
    sizing: "burst",
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
    ownServer: true,
    lane: "hivra-agent",
    browser: "none",
    sizing: "pinned",
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
    ownServer: false,
    lane: "prepared-computer",
    browser: "none",
    sizing: "fixed",
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
    ownServer: true,
    lane: "windows-installer",
    browser: "none",
    sizing: "fixed",
    recommended: { ...recommendedResourceEnvelope("windows"), source: "recommended" },
    cpuOptions: [4],
    ramOptions: [8],
  },
};

export const LAUNCH_PROFILE_IDS: readonly LaunchProfileId[] = [
  "claude-code", "codex", "hermes", "openclaw", "agent-zero", "aeon",
  "ubuntu-desktop", "linux-terminal", "omarchy", "windows",
];

/** Profiles whose computer can carry the optional browser. */
export function profileHasBrowser(profileId: LaunchProfileId | null): boolean {
  return profileId !== null && PROFILE_DETAILS[profileId].browser !== "none";
}

export function isLaunchProfileId(value: unknown): value is LaunchProfileId {
  return typeof value === "string" && (LAUNCH_PROFILE_IDS as readonly string[]).includes(value);
}

/** Launch names are 1-60 characters on every launch route. */
export const LAUNCH_NAME_MAX_LENGTH = 60;
/** The Hermes instance lane accepts names of at most 50 characters. */
export const HERMES_NAME_MAX_LENGTH = 50;
