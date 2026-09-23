import {
  LAUNCH_DRAFT_SCHEMA_VERSION,
  PROFILE_DETAILS,
  type LaunchCapacityChoice,
  type LaunchDraft,
  type LaunchDeploymentSnapshot,
  type LaunchProfileId,
  type LaunchResourceKind,
  type LaunchResources,
  type LaunchStage,
  type LaunchState,
} from "./contracts";

export const LAUNCH_DRAFT_STORAGE_KEY = "hivra.launch-draft.v1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = new Set<LaunchStage>(["type", "profile", "capacity", "review", "launch"]);
const RESOURCE_KINDS = new Set<LaunchResourceKind>(["agent", "computer"]);
const PROFILES = new Set<LaunchProfileId>(["codex", "ubuntu-desktop", "linux-terminal", "omarchy", "windows"]);
const LAUNCH_STATES = new Set<LaunchState>(["idle", "submitting", "uncertain", "accepted", "failed"]);

function newRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function createLaunchDraft(): LaunchDraft {
  return {
    schemaVersion: LAUNCH_DRAFT_SCHEMA_VERSION,
    launchRequestId: newRequestId(),
    stage: "type",
    resourceKind: null,
    profileId: null,
    name: "",
    resources: { ...PROFILE_DETAILS.codex.recommended },
    windowsIsoVolume: null,
    windowsIsoEvidence: null,
    windowsIsoSource: "unknown",
    windowsIsoDownload: null,
    windowsRightsAttested: false,
    browser: false,
    browserSource: "recommended",
    browserRaisedFrom: null,
    capacity: { mode: "hivra-managed", targetId: null },
    submittedDeployment: null,
    launchState: "idle",
    result: null,
    error: null,
  };
}

function finiteResource(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function safeResources(value: unknown): LaunchResources | null {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const cpu = finiteResource(input.cpu, 0.5, 8);
  const ram = finiteResource(input.ram, 1, 16);
  if (cpu === null || ram === null) return null;
  // Draft v1 predates explicit ceilings. Preserve those drafts as pinned
  // allocations instead of silently granting a larger burst envelope.
  const maximumCpu = finiteResource(input.maximumCpu, cpu, 8) ?? cpu;
  const maximumRam = finiteResource(input.maximumRam, ram, 16) ?? ram;
  const source = input.source === "custom" ? "custom" as const : "recommended" as const;
  return { cpu, ram, maximumCpu, maximumRam, source };
}

function safeSubmittedDeployment(value: unknown): LaunchDeploymentSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.mode === "hivra-managed") return { mode: "hivra-managed" };
  if (
    input.mode === "self-managed"
    && typeof input.connectionId === "string"
    && UUID.test(input.connectionId)
    && typeof input.targetId === "string"
    && UUID.test(input.targetId)
    && typeof input.expectedConnectionRevision === "number"
    && Number.isInteger(input.expectedConnectionRevision)
    && input.expectedConnectionRevision > 0
  ) {
    return {
      mode: "self-managed",
      connectionId: input.connectionId.toLowerCase(),
      targetId: input.targetId.toLowerCase(),
      expectedConnectionRevision: input.expectedConnectionRevision,
    };
  }
  return null;
}

function safeDraft(value: unknown): LaunchDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== LAUNCH_DRAFT_SCHEMA_VERSION) return null;
  if (typeof input.launchRequestId !== "string" || !UUID.test(input.launchRequestId)) return null;

  const stage = typeof input.stage === "string" && STAGES.has(input.stage as LaunchStage)
    ? input.stage as LaunchStage
    : "type";
  const resourceKind = typeof input.resourceKind === "string" && RESOURCE_KINDS.has(input.resourceKind as LaunchResourceKind)
    ? input.resourceKind as LaunchResourceKind
    : null;
  const profileId = typeof input.profileId === "string" && PROFILES.has(input.profileId as LaunchProfileId)
    ? input.profileId as LaunchProfileId
    : null;
  if (profileId && PROFILE_DETAILS[profileId].resourceKind !== resourceKind) return null;

  const resources = safeResources(input.resources);
  if (!resources) return null;
  // Only an owner's own Codex size is ever given back after a browser raise.
  const browserRaisedFrom = profileId === "codex" ? safeResources(input.browserRaisedFrom) : null;

  const capacityInput = input.capacity && typeof input.capacity === "object"
    ? input.capacity as Record<string, unknown>
    : {};
  let capacity: LaunchCapacityChoice;
  if (capacityInput.mode === "self-managed") {
    capacity = {
      mode: "self-managed",
      targetId: typeof capacityInput.targetId === "string" && UUID.test(capacityInput.targetId)
        ? capacityInput.targetId.toLowerCase()
        : null,
    };
  } else {
    capacity = { mode: "hivra-managed", targetId: null };
  }

  const storedState = typeof input.launchState === "string" && LAUNCH_STATES.has(input.launchState as LaunchState)
    ? input.launchState as LaunchState
    : "idle";
  const launchState = storedState === "submitting" ? "uncertain" : storedState;
  const resultInput = input.result && typeof input.result === "object"
    ? input.result as Record<string, unknown>
    : null;
  const result = resultInput
    && typeof resultInput.id === "string"
    && UUID.test(resultInput.id)
    && typeof resultInput.name === "string"
    && typeof resultInput.status === "string"
    ? { id: resultInput.id, name: resultInput.name.slice(0, 64), status: resultInput.status.slice(0, 32) }
    : null;
  const downloadInput = input.windowsIsoDownload && typeof input.windowsIsoDownload === "object" && !Array.isArray(input.windowsIsoDownload)
    ? input.windowsIsoDownload as Record<string, unknown> : null;
  const windowsIsoDownload: LaunchDraft["windowsIsoDownload"] = downloadInput
    && typeof downloadInput.taskId === "string" && UUID.test(downloadInput.taskId)
    && typeof downloadInput.connectionId === "string" && UUID.test(downloadInput.connectionId)
    && typeof downloadInput.targetId === "string" && UUID.test(downloadInput.targetId)
    && Number.isSafeInteger(downloadInput.expectedConnectionRevision) && Number(downloadInput.expectedConnectionRevision) > 0
    && (downloadInput.source === "windows-11" || downloadInput.source === "windows-server-evaluation")
    && typeof downloadInput.storage === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(downloadInput.storage)
    && typeof downloadInput.filename === "string" && /^[A-Za-z0-9][A-Za-z0-9._+() -]{0,190}\.iso$/i.test(downloadInput.filename)
    && (downloadInput.state === "queued" || downloadInput.state === "running")
      ? {
          taskId: downloadInput.taskId.toLowerCase(), connectionId: downloadInput.connectionId.toLowerCase(),
          targetId: downloadInput.targetId.toLowerCase(), expectedConnectionRevision: Number(downloadInput.expectedConnectionRevision),
          source: downloadInput.source, storage: downloadInput.storage, filename: downloadInput.filename, state: downloadInput.state,
        } : null;

  return {
    schemaVersion: LAUNCH_DRAFT_SCHEMA_VERSION,
    launchRequestId: input.launchRequestId.toLowerCase(),
    stage,
    resourceKind,
    profileId,
    name: typeof input.name === "string" ? input.name.slice(0, 64) : "",
    resources,
    windowsIsoVolume: typeof input.windowsIsoVolume === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:iso\/[A-Za-z0-9][A-Za-z0-9._+@() -]{0,190}\.iso$/i.test(input.windowsIsoVolume)
      ? input.windowsIsoVolume : null,
    windowsIsoEvidence: input.windowsIsoEvidence && typeof input.windowsIsoEvidence === "object" && !Array.isArray(input.windowsIsoEvidence)
      && Number.isSafeInteger((input.windowsIsoEvidence as Record<string, unknown>).sizeBytes)
      && Number((input.windowsIsoEvidence as Record<string, unknown>).sizeBytes) > 0
      && Number.isSafeInteger((input.windowsIsoEvidence as Record<string, unknown>).modifiedAtSeconds)
      && Number((input.windowsIsoEvidence as Record<string, unknown>).modifiedAtSeconds) >= 0
      && typeof (input.windowsIsoEvidence as Record<string, unknown>).fileIdentitySha256 === "string"
      && /^[a-f0-9]{64}$/.test(String((input.windowsIsoEvidence as Record<string, unknown>).fileIdentitySha256))
      ? input.windowsIsoEvidence as LaunchDraft["windowsIsoEvidence"] : null,
    windowsIsoSource: input.windowsIsoSource === "windows-11" || input.windowsIsoSource === "windows-server-evaluation"
      ? input.windowsIsoSource : "unknown",
    windowsIsoDownload,
    windowsRightsAttested: input.windowsRightsAttested === true,
    // Drafts saved before this choice existed launched Codex with its browser
    // sidecar. Restore that intent so an uncertain replay repeats it exactly.
    browser: profileId === "codex" ? (typeof input.browser === "boolean" ? input.browser : true) : false,
    browserSource: input.browserSource === "custom" ? "custom" : "recommended",
    browserRaisedFrom: browserRaisedFrom?.source === "custom" ? browserRaisedFrom : null,
    capacity,
    submittedDeployment: safeSubmittedDeployment(input.submittedDeployment),
    launchState,
    result,
    error: typeof input.error === "string" ? input.error.slice(0, 500) : null,
  };
}

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

export function readLaunchDraft(): LaunchDraft | null {
  const target = storage();
  if (!target) return null;
  try {
    const raw = target.getItem(LAUNCH_DRAFT_STORAGE_KEY);
    return raw ? safeDraft(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeLaunchDraft(draft: LaunchDraft): void {
  const target = storage();
  if (!target) return;
  const safe = safeDraft(draft);
  if (!safe) return;
  target.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify(safe));
}

export function clearLaunchDraft(): void {
  storage()?.removeItem(LAUNCH_DRAFT_STORAGE_KEY);
}
