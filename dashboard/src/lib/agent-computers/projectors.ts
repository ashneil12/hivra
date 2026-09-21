import {
  AGENT_COMPUTER_CONTRACT_VERSION,
  AgentComputerSchema,
  type AgentComputer,
  type AgentComputerAction,
  type AgentComputerDesiredState,
  type AgentComputerHealthState,
  type AgentComputerObservedState,
  type AgentComputerOperation,
  type AgentComputerSurface,
} from "./contracts";

export interface HermesLegacyComputerRecord {
  id: string;
  name: string;
  status?: string | null;
  backend?: string | null;
}

export interface HivraLegacyComputerRecord {
  id: string;
  name: string;
  status?: string | null;
  type?: string | null;
  computerProfile?: string | null;
  computerSubstrate?: string | null;
  browserEnabled?: boolean;
  canProvision?: boolean;
}

export interface LegacyComputerEvidence {
  desired?: AgentComputerDesiredState;
  health?: AgentComputerHealthState;
  operation?: AgentComputerOperation | null;
}

const HERMES_WEBFREE_BACKENDS = new Set(["gateway", "webui"]);
const HIVRA_CLI_TYPES = new Set([
  "hermes",
  "claude-code",
  "codex",
  "openclaw",
  "agent-zero",
]);
const HIVRA_DASHBOARD_TYPES = new Set(["aeon"]);
const HIVRA_COMPUTER_TYPES = new Set(["linux-desktop"]);

function normalizedLabel(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized.slice(0, 64) : undefined;
}

function observedFromStatus(
  sourceStatus: string | undefined
): AgentComputerObservedState {
  switch (sourceStatus) {
    case "provisioning":
    case "redeploying":
    case "restoring":
      return "provisioning";
    case "running":
      return "running";
    case "stopped":
    case "paused":
      return "stopped";
    case "suspended":
      return "suspended";
    case "deleting":
      return "deleting";
    case "deleted":
      return "missing";
    case "error":
    case "failed":
      return "error";
    default:
      return "unknown";
  }
}

function stateFromEvidence(
  observed: AgentComputerObservedState,
  evidence: LegacyComputerEvidence | undefined
) {
  return {
    desired: evidence?.desired ?? ("unknown" as const),
    observed,
    health: evidence?.health ?? ("unknown" as const),
    operation: evidence?.operation ?? null,
  };
}

function hermesCapabilities(
  record: HermesLegacyComputerRecord,
  sourceStatus: string | undefined
): { surfaces: AgentComputerSurface[]; actions: AgentComputerAction[] } {
  const recognizedBackend =
    typeof record.backend === "string" &&
    HERMES_WEBFREE_BACKENDS.has(record.backend.trim().toLowerCase());
  if (!recognizedBackend || !sourceStatus || sourceStatus === "deleted") {
    return { surfaces: [], actions: [] };
  }

  const recognizedStatuses = new Set([
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
  if (!recognizedStatuses.has(sourceStatus)) {
    return { surfaces: [], actions: [] };
  }

  // A Hermes instance's own web UI is the conversation: "workspace", "browser"
  // and "native" were all the same embed as the Conversation tab, so declaring
  // them produced duplicate tabs that opened the identical surface (or, when no
  // renderer was wired, an empty one). The terminal is the only surface that
  // genuinely adds something beside the conversation.
  const surfaces: AgentComputerSurface[] =
    sourceStatus === "running" ? ["terminal"] : [];

  switch (sourceStatus) {
    case "running":
      return { surfaces, actions: ["stop", "reboot", "delete"] };
    case "stopped":
    case "paused":
    case "suspended":
      return { surfaces, actions: ["start", "delete"] };
    case "provisioning":
    case "redeploying":
    case "restoring":
    case "deleting":
      return { surfaces, actions: ["delete"] };
    case "error":
    case "failed":
      return { surfaces, actions: ["start", "delete"] };
    default:
      return { surfaces: [], actions: [] };
  }
}

function hivraCapabilities(
  record: HivraLegacyComputerRecord,
  sourceStatus: string | undefined
): { surfaces: AgentComputerSurface[]; actions: AgentComputerAction[] } {
  const type = normalizedLabel(record.type);
  const isCli = type ? HIVRA_CLI_TYPES.has(type) : false;
  const isDashboard = type ? HIVRA_DASHBOARD_TYPES.has(type) : false;
  const isComputer = type ? HIVRA_COMPUTER_TYPES.has(type) : false;
  const computerProfile = normalizedLabel(record.computerProfile);
  const isWindowsComputer = isComputer && computerProfile === "windows";
  const hasProxmoxLifecycle = normalizedLabel(record.computerSubstrate) === "proxmox-kvm";
  const recognizedStatus =
    sourceStatus === "provisioning" ||
    sourceStatus === "running" ||
    sourceStatus === "stopped" ||
    sourceStatus === "error";

  if ((!isCli && !isDashboard && !isComputer) || !recognizedStatus) {
    return { surfaces: [], actions: [] };
  }

  const surfaces: AgentComputerSurface[] = [];
  if (sourceStatus === "running") {
    // No "workspace": for a dashboard agent (Agent Zero/Aeon/OpenClaw) the
    // Conversation tab already embeds that same runtime, and naming a second tab
    // after the product just duplicated it. For CLI agents the workspace was a
    // bare hand-off frame. The runtime is reached through the conversation.
    if (isCli) surfaces.push("files", "git", "terminal");
    if (isCli && record.browserEnabled === true) surfaces.push("browser");
    // Windows currently has an accepted remote desktop path, but no native
    // Hivra Files or web-terminal runtime. Keep those Linux-only surfaces out
    // of the shared capability contract until a Windows adapter proves them.
    if (isComputer) {
      if (!isWindowsComputer) surfaces.push("files", "terminal");
      surfaces.push("desktop");
    }
  }

  const actions: AgentComputerAction[] = [];
  if (record.canProvision === true) actions.push("provision");
  if (isComputer) {
    if (sourceStatus === "running") {
      actions.push("stop", "reboot", "delete");
      if (hasProxmoxLifecycle) actions.push("resize", "snapshot", "restore");
      return { surfaces, actions };
    }
    if (sourceStatus === "stopped") {
      actions.push("start", "delete");
      if (hasProxmoxLifecycle) actions.push("resize", "snapshot", "restore");
      return { surfaces, actions };
    }
    if (sourceStatus === "error") {
      actions.push("start", "delete");
      if (hasProxmoxLifecycle) actions.push("restore");
      return { surfaces, actions };
    }
  }
  actions.push("delete");

  return { surfaces, actions };
}

export function projectHermesInstance(
  record: HermesLegacyComputerRecord,
  evidence?: LegacyComputerEvidence
): AgentComputer {
  const sourceStatus = normalizedLabel(record.status);
  const projected = {
    contractVersion: AGENT_COMPUTER_CONTRACT_VERSION,
    id: `h-${record.id}`,
    name: record.name,
    source: { kind: "hermes" as const, id: record.id },
    capabilities: hermesCapabilities(record, sourceStatus),
    state: stateFromEvidence(observedFromStatus(sourceStatus), evidence),
    compatibility: {
      mode: "projected" as const,
      ...(sourceStatus ? { sourceStatus } : {}),
    },
  };

  return AgentComputerSchema.parse(projected);
}

export function projectHivraAgent(
  record: HivraLegacyComputerRecord,
  evidence?: LegacyComputerEvidence
): AgentComputer {
  const sourceStatus = normalizedLabel(record.status);
  const projected = {
    contractVersion: AGENT_COMPUTER_CONTRACT_VERSION,
    id: `x-${record.id}`,
    name: record.name,
    source: { kind: "hivra" as const, id: record.id },
    capabilities: hivraCapabilities(record, sourceStatus),
    state: stateFromEvidence(observedFromStatus(sourceStatus), evidence),
    compatibility: {
      mode: "projected" as const,
      ...(sourceStatus ? { sourceStatus } : {}),
    },
  };

  return AgentComputerSchema.parse(projected);
}
