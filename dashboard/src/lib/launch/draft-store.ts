import {
  DEFAULT_MODEL_ACCESS,
  LAUNCH_DRAFT_SCHEMA_VERSION,
  LAUNCH_NAME_MAX_LENGTH,
  LAUNCH_PROFILE_IDS,
  PROFILE_DETAILS,
  profileHasBrowser,
  type LaunchCapacityChoice,
  type LaunchDraft,
  type LaunchDraftTemplate,
  type LaunchDeploymentSnapshot,
  type LaunchErrorAction,
  type LaunchModelAccess,
  type LaunchProfileId,
  type LaunchResourceKind,
  type LaunchResources,
  type LaunchStage,
  type LaunchState,
} from "./contracts";
import { launchProfileForTemplate, safeTemplateRef } from "./launch-template";

/** Drafts live in this browser's localStorage under this prefix plus the
 * signed-in owner's id, so a draft survives a closed tab, a second tab and
 * the Stripe round trip, and one account never resumes another's draft on a
 * shared browser. Older drafts were kept per tab in sessionStorage under the
 * bare prefix; they are moved over on first read. */
export const LAUNCH_DRAFT_STORAGE_KEY = "hivra.launch-draft.v1";

export function launchDraftStorageKey(ownerId: string): string {
  return `${LAUNCH_DRAFT_STORAGE_KEY}:${ownerId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = new Set<LaunchStage>(["choose", "plan", "review", "launch"]);
/** Stages from before the Choose screen merged the type and profile screens. */
const LEGACY_STAGES: Readonly<Record<string, LaunchStage>> = {
  type: "choose",
  profile: "choose",
  capacity: "plan",
};
const RESOURCE_KINDS = new Set<LaunchResourceKind>(["agent", "computer"]);
const PROFILES = new Set<LaunchProfileId>(LAUNCH_PROFILE_IDS);
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
    stage: "choose",
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
    modelAccess: { ...DEFAULT_MODEL_ACCESS },
    sendMemoryKey: false,
    template: null,
    submittedDeployment: null,
    submittedAt: null,
    launchState: "idle",
    result: null,
    error: null,
    errorAction: null,
  };
}

const MODEL_ACCESS_MODES = new Set<LaunchModelAccess["mode"]>(["native", "api-key", "credits"]);
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_ID = /^[\x21-\x7e]{1,128}$/;

/** An endpoint address without credentials in it. */
function safeBaseUrl(value: string): string {
  if (!value || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? value : "";
  } catch {
    return "";
  }
}

/** Secret-free model choice. Unknown fields (a key included) are dropped. */
function safeModelAccess(value: unknown): LaunchModelAccess {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_MODEL_ACCESS };
  const input = value as Record<string, unknown>;
  const mode = typeof input.mode === "string" && MODEL_ACCESS_MODES.has(input.mode as LaunchModelAccess["mode"])
    ? input.mode as LaunchModelAccess["mode"]
    : DEFAULT_MODEL_ACCESS.mode;
  const baseUrl = typeof input.baseUrl === "string" ? safeBaseUrl(input.baseUrl) : "";
  return {
    mode,
    source: input.source === "custom" ? "custom" : "recommended",
    provider: typeof input.provider === "string" && PROVIDER_ID.test(input.provider) ? input.provider : DEFAULT_MODEL_ACCESS.provider,
    model: typeof input.model === "string" && (input.model === "" || MODEL_ID.test(input.model)) ? input.model : "",
    keySource: input.keySource === "saved" ? "saved" : "paste",
    vaultKeyId: typeof input.vaultKeyId === "string" && UUID.test(input.vaultKeyId) ? input.vaultKeyId.toLowerCase() : null,
    sendSavedKey: input.sendSavedKey === true,
    saveKey: input.saveKey === true,
    walletType: input.walletType === "hermesos" ? "hermesos" : "card",
    baseUrl,
  };
}

/** Only a link back into this dashboard can ride along with an error. */
function safeErrorAction(value: unknown): LaunchErrorAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.kind === "verify-card") return { kind: "verify-card" };
  if (
    input.kind === "open"
    && typeof input.label === "string" && input.label.trim() && input.label.length <= 60
    && typeof input.href === "string" && /^\/dashboard\/[A-Za-z0-9/_?=&%.-]{1,300}$/.test(input.href)
  ) {
    return { kind: "open", label: input.label.trim(), href: input.href };
  }
  return null;
}

/** A template id and name, and only for a profile a template can start. */
function safeTemplate(value: unknown, profileId: LaunchProfileId | null): LaunchDraftTemplate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const id = safeTemplateRef(input.id);
  if (!id || !profileId || launchProfileForTemplate(profileId) !== profileId) return null;
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, LAUNCH_NAME_MAX_LENGTH) : null;
  return { id, name };
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
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
    : typeof input.stage === "string" && Object.hasOwn(LEGACY_STAGES, input.stage)
      ? LEGACY_STAGES[input.stage]
      : "choose";
  const resourceKind = typeof input.resourceKind === "string" && RESOURCE_KINDS.has(input.resourceKind as LaunchResourceKind)
    ? input.resourceKind as LaunchResourceKind
    : null;
  const profileId = typeof input.profileId === "string" && PROFILES.has(input.profileId as LaunchProfileId)
    ? input.profileId as LaunchProfileId
    : null;
  if (profileId && PROFILE_DETAILS[profileId].resourceKind !== resourceKind) return null;

  const resources = safeResources(input.resources);
  if (!resources) return null;
  // Only an owner's own size is ever given back after a browser raise.
  const hasBrowser = profileHasBrowser(profileId);
  const browserRaisedFrom = hasBrowser ? safeResources(input.browserRaisedFrom) : null;

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
    name: typeof input.name === "string" ? input.name.slice(0, LAUNCH_NAME_MAX_LENGTH) : "",
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
    browser: hasBrowser
      ? (typeof input.browser === "boolean" ? input.browser : profileId === "codex")
      : false,
    browserSource: input.browserSource === "custom" ? "custom" : "recommended",
    browserRaisedFrom: browserRaisedFrom?.source === "custom" ? browserRaisedFrom : null,
    capacity,
    modelAccess: safeModelAccess(input.modelAccess),
    // Consent to send a saved memory key is Hermes' only, and only ever true.
    sendMemoryKey: profileId === "hermes" && input.sendMemoryKey === true,
    template: safeTemplate(input.template, profileId),
    submittedDeployment: safeSubmittedDeployment(input.submittedDeployment),
    submittedAt: safeTimestamp(input.submittedAt),
    launchState,
    result,
    error: typeof input.error === "string" ? input.error.slice(0, 500) : null,
    errorAction: safeErrorAction(input.errorAction),
  };
}

function localDrafts(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage denied by browser privacy settings.
    return null;
  }
}

function legacyTabDrafts(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function parseStoredDraft(raw: string | null): LaunchDraft | null {
  if (!raw) return null;
  try {
    return safeDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The owner's saved draft in this browser. Without a known owner there is
 * nothing to read: a draft is never shown to an account that did not save it. */
export function readLaunchDraft(ownerId: string | null): LaunchDraft | null {
  if (!ownerId) return null;
  const target = localDrafts();
  const key = launchDraftStorageKey(ownerId);
  try {
    const saved = parseStoredDraft(target?.getItem(key) ?? null);
    if (saved) return saved;
  } catch {
    return null;
  }
  // A draft this tab saved before drafts moved to localStorage.
  const legacy = legacyTabDrafts();
  let migrated: LaunchDraft | null = null;
  try {
    migrated = parseStoredDraft(legacy?.getItem(LAUNCH_DRAFT_STORAGE_KEY) ?? null);
    legacy?.removeItem(LAUNCH_DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (migrated) writeLaunchDraft(migrated, ownerId);
  return migrated;
}

export function writeLaunchDraft(draft: LaunchDraft, ownerId: string | null): void {
  if (!ownerId) return;
  const safe = safeDraft(draft);
  if (!safe) return;
  try {
    localDrafts()?.setItem(launchDraftStorageKey(ownerId), JSON.stringify(safe));
  } catch {
    // A full or denied store keeps the in-memory draft only.
  }
}

export function clearLaunchDraft(ownerId: string | null): void {
  try {
    if (ownerId) localDrafts()?.removeItem(launchDraftStorageKey(ownerId));
    legacyTabDrafts()?.removeItem(LAUNCH_DRAFT_STORAGE_KEY);
  } catch {
    // Nothing else to clear.
  }
}

/** A draft the owner started and has not launched yet: resuming it is a
 * choice, never something a new launch link silently throws away. */
export function isUnfinishedLaunchDraft(draft: LaunchDraft | null): draft is LaunchDraft {
  return Boolean(draft?.profileId)
    && (draft?.launchState === "idle" || draft?.launchState === "failed");
}
