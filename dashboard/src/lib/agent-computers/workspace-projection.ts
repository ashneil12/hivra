import {
  AgentComputerSchema,
  type AgentComputer,
  type AgentComputerSurface,
} from "./contracts";
import {
  projectHermesInstance,
  projectHivraAgent,
  type HermesLegacyComputerRecord,
  type HivraLegacyComputerRecord,
  type LegacyComputerEvidence,
} from "./projectors";

export interface WorkspaceSurfaceDescriptor {
  surface: AgentComputerSurface;
  label: string;
}

export type WorkspaceProjectionReason =
  | "invalid-record"
  | "missing-evidence"
  | "deleted-record"
  | "unsupported-record";

export type WorkspaceProjectionResult =
  | {
      ok: true;
      computer: AgentComputer;
      surfaces: WorkspaceSurfaceDescriptor[];
      compatibility: {
        mode: "projected";
        label: "Compatibility mode";
      };
    }
  | {
      ok: false;
      state: "unknown" | "invalid";
      reason: WorkspaceProjectionReason;
      surfaces: [];
    };

const SURFACE_LABELS: Record<AgentComputerSurface, string> = {
  workspace: "Workspace",
  files: "Files",
  git: "Git",
  terminal: "Terminal",
  browser: "Browser",
  desktop: "Desktop",
  native: "Native runtime",
};

const HERMES_STATUSES = new Set([
  "provisioning",
  "redeploying",
  "restoring",
  "running",
  "stopped",
  "paused",
  "suspended",
  "deleting",
  "error",
  "failed",
]);
const HERMES_BACKENDS = new Set(["gateway", "webui"]);
const HIVRA_STATUSES = new Set(["provisioning", "running", "stopped", "error"]);
const HIVRA_TYPES = new Set([
  "hermes",
  "claude-code",
  "codex",
  "openclaw",
  "agent-zero",
  "aeon",
  "linux-desktop",
]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalLabel(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function invalidProjection(): WorkspaceProjectionResult {
  return {
    ok: false,
    state: "invalid",
    reason: "invalid-record",
    surfaces: [],
  };
}

function unknownProjection(
  reason: Exclude<WorkspaceProjectionReason, "invalid-record">,
): WorkspaceProjectionResult {
  return {
    ok: false,
    state: "unknown",
    reason,
    surfaces: [],
  };
}

function successfulProjection(computerValue: unknown): WorkspaceProjectionResult {
  const computer = AgentComputerSchema.parse(computerValue);
  const surfaces = computer.capabilities.surfaces
    .filter((surface) => Object.hasOwn(SURFACE_LABELS, surface))
    .map((surface) => ({
      surface,
      label: SURFACE_LABELS[surface],
    }));

  return {
    ok: true,
    computer,
    surfaces,
    compatibility: {
      mode: "projected",
      label: "Compatibility mode",
    },
  };
}

export function projectWorkspaceHermes(
  value: unknown,
  evidence?: LegacyComputerEvidence,
): WorkspaceProjectionResult {
  const record = asRecord(value);
  if (!record) return invalidProjection();

  const id = requiredString(record.id);
  const name = requiredString(record.name);
  const status = optionalLabel(record.status);
  const backend = optionalLabel(record.backend);
  if (!id || !name || status === null || backend === null) return invalidProjection();
  if (!status || !backend) return unknownProjection("missing-evidence");
  if (status === "deleted") return unknownProjection("deleted-record");
  if (!HERMES_STATUSES.has(status) || !HERMES_BACKENDS.has(backend)) {
    return unknownProjection("unsupported-record");
  }

  const safeRecord: HermesLegacyComputerRecord = {
    id,
    name,
    status,
    backend,
  };

  try {
    return successfulProjection(projectHermesInstance(safeRecord, evidence));
  } catch {
    return invalidProjection();
  }
}

export function projectWorkspaceHivra(
  value: unknown,
  evidence?: LegacyComputerEvidence,
): WorkspaceProjectionResult {
  const record = asRecord(value);
  if (!record) return invalidProjection();

  const id = requiredString(record.id);
  const name = requiredString(record.name);
  const status = optionalLabel(record.status);
  const type = optionalLabel(record.type);
  const computerProfile = optionalLabel(record.computerProfile);
  if (
    !id || !name || status === null || type === null || computerProfile === null
  ) return invalidProjection();
  if (
    (record.browserEnabled !== undefined && typeof record.browserEnabled !== "boolean") ||
    (record.canProvision !== undefined && typeof record.canProvision !== "boolean")
  ) {
    return invalidProjection();
  }
  if (!status || !type) return unknownProjection("missing-evidence");
  if (status === "deleted") return unknownProjection("deleted-record");
  if (!HIVRA_STATUSES.has(status) || !HIVRA_TYPES.has(type)) {
    return unknownProjection("unsupported-record");
  }

  const safeRecord: HivraLegacyComputerRecord = {
    id,
    name,
    status,
    type,
    computerProfile,
    browserEnabled: record.browserEnabled === true,
    canProvision: record.canProvision === true,
  };

  try {
    return successfulProjection(projectHivraAgent(safeRecord, evidence));
  } catch {
    return invalidProjection();
  }
}
