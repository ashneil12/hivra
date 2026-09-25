// The Manage capability map: which sections and controls a computer's Manage
// page offers, and for everything it can't offer, why.
//
// Computed on the server from the stored row (GET /api/hivra/agents/[id]),
// where the private fields that decide support (the ownership binding, the
// operation lease, the prepared slot) are visible, and sent as public output
// only: no host names, binding values, operation payloads or private
// addresses. Every rule comes from lifecycle-support.ts, which the lifecycle
// routes use too, so Manage offers what the server allows and nothing else.
// Pure: no I/O. What depends on the running gateway (its chat model,
// permissions, tools and CLI version) is still detected by the page.

import { getAgent as catalogAgent } from "@/lib/hivra/agent-catalog";
import { getComputerTemplate } from "@/lib/hivra/computer-catalog";
import {
  COMPUTER_PLACEMENT_LABEL,
  computerPlacementFor,
} from "@/lib/agent-computers/agent-surfaces";
import { AGENT_CLI_VERSIONS } from "@/lib/infrastructure/portable-provisioner-contract";
import {
  folderRecoveryEligible,
  hasOwnershipBinding,
  isPreparedProfile,
  isWindowsOnMyServer,
  privateNetworkReason,
  restorePointSupport,
  runtimeUpdateRefusal,
  type LifecycleSupportRow,
  type PrivateNetworkReason,
} from "@/lib/hivra/lifecycle-support";
import {
  MANAGE_SECTION_IDS,
  capShown,
  type ManageCap,
  type ManageCapabilities,
  type ManageDetail,
  type ManageSectionId,
  type ManageVariant,
} from "@/lib/hivra/manage-sections";

export type { ManageCapabilities } from "@/lib/hivra/manage-sections";

/** The stored hivra_agents fields the map reads. Everything else is ignored. */
export interface ManageCapabilitiesRow extends LifecycleSupportRow {
  id?: unknown;
  name?: unknown;
  cpu?: unknown;
  ram?: unknown;
  ip?: unknown;
  vmid?: unknown;
  created_at?: unknown;
  provisioned_at?: unknown;
}

export interface ManageCapabilitiesContext {
  /** matchPreparedCanaryComputer(row) found this prepared computer's slot. */
  preparedMatch: boolean;
  /**
   * Adding an agent to this computer is offered (the Agents section).
   * Extension point: the attach work sets this from its own eligibility and
   * renders its panel in that section. Until then no computer offers it.
   */
  attachAgents?: boolean;
  /**
   * An agent is attached to this computer, so restoring it would roll the
   * computer back under that agent. Extension point for the attach work.
   */
  agentAttached?: boolean;
}

const available: ManageCap = { state: "available" };
const blocked = (code: string, reason: string): ManageCap => ({ state: "blocked", code, reason });
const unavailable = (code: string, reason: string): ManageCap => ({ state: "unavailable", code, reason });

const WAIT = "Wait for the current operation to finish.";

function amount(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function sizeOf(row: ManageCapabilitiesRow): string {
  return `${amount(row.cpu)} CPU / ${amount(row.ram)} GB`;
}

function variantOf(row: ManageCapabilitiesRow, isComputer: boolean): ManageVariant {
  if (row.computer_substrate === "do-managed-session") return "digitalocean";
  if (row.computer_substrate === "gvisor") return "linux-sandbox";
  if (isComputer) {
    if (row.computer_substrate === "provider-vm") return "my-cloud";
    if (isWindowsOnMyServer(row)) return "windows-my-server";
    if (isPreparedProfile(row)) return "prepared";
    return "ubuntu-proxmox";
  }
  if (row.computer_substrate === "provider-vm") return "my-cloud-agent";
  return catalogAgent(String(row.type))?.surface === "dashboard" ? "dashboard-agent" : "chat-agent";
}

function operationInProgress(row: ManageCapabilitiesRow): boolean {
  return row.status === "provisioning" || row.operation_id != null || row.operation_kind != null;
}

const MY_CLOUD_FORCE = "Hivra can't force a My cloud computer off. Use your provider's console to force it off.";

function powerCaps(row: ManageCapabilitiesRow, variant: ManageVariant, ctx: ManageCapabilitiesContext): ManageCapabilities["power"] {
  if (variant === "windows-my-server") {
    const reason = "Hivra can't start, stop or restart a Windows computer on your own server yet. Use your server's console for now.";
    const cap = unavailable("windows_my_server", reason);
    return { start: cap, stop: cap, restart: cap, forceStop: cap, forceRestart: cap };
  }
  if (variant === "prepared" && !ctx.preparedMatch) {
    const cap = unavailable("prepared_mismatch", "This prepared computer no longer matches the setup Hivra has on record, so its power controls are off. Contact support.");
    return { start: cap, stop: cap, restart: cap, forceStop: cap, forceRestart: cap };
  }
  const busy = operationInProgress(row);
  const stopped = row.status === "stopped";
  const start = busy ? blocked("operation_in_progress", WAIT)
    : stopped ? available : blocked("already_on", "This computer is already on.");
  const stop = busy ? blocked("operation_in_progress", WAIT)
    : stopped ? blocked("already_stopped", "This computer is already stopped.") : available;
  const restartCap = busy ? blocked("operation_in_progress", WAIT)
    : stopped ? blocked("stopped", "Start this computer first.") : available;
  if (variant === "digitalocean") return { start, stop, restart: null, forceStop: null, forceRestart: null, labels: { start: "Resume", stop: "Pause" } };
  if (variant === "linux-sandbox") return { start, stop, restart: null, forceStop: null, forceRestart: null };
  if (variant === "my-cloud" || variant === "my-cloud-agent") {
    // The Hetzner power client never forces power; the route refuses both.
    const cap = unavailable("my_cloud", MY_CLOUD_FORCE);
    return { start, stop, restart: restartCap, forceStop: cap, forceRestart: cap };
  }
  // Force off takes the same lease as Stop, so it waits for the same things.
  return { start, stop, restart: restartCap, forceStop: stop, forceRestart: restartCap };
}

const USAGE_NOT_BOUND = "Live usage isn't available for this computer. It was created before Hivra recorded ownership checks.";

/**
 * Live usage (the usage route): Proxmox computers only, read from their host
 * behind the same ownership checks as Stop. Elsewhere, say where to look.
 */
function usageCap(row: ManageCapabilitiesRow, variant: ManageVariant, ctx: ManageCapabilitiesContext): ManageCap {
  switch (variant) {
    case "digitalocean":
      return unavailable("digitalocean", "Live usage isn't available for DigitalOcean sessions. Status and last activity come from DigitalOcean.");
    case "linux-sandbox":
      return unavailable("linux_sandbox", "Live usage isn't available for Linux Sandboxes yet.");
    case "my-cloud":
    case "my-cloud-agent":
      return unavailable("my_cloud", "Live usage isn't available for My cloud computers yet. Your provider's console shows it.");
    case "prepared":
      if (!ctx.preparedMatch) return unavailable("prepared_mismatch", "This prepared computer no longer matches the setup Hivra has on record, so Hivra doesn't read its usage.");
      break;
    default:
      break;
  }
  // My server rows are always bound; an unbound one can't be read safely.
  if (row.deployment_mode === "self-managed" && !hasOwnershipBinding(row)) return unavailable("not_bound", USAGE_NOT_BOUND);
  if (!Number.isSafeInteger(row.vmid) || Number(row.vmid) < 100) {
    return blocked("not_ready", "Usage appears once this computer is set up.");
  }
  return available;
}

function resizeCap(row: ManageCapabilitiesRow, variant: ManageVariant): ManageCapabilities["resize"] {
  switch (variant) {
    case "prepared": {
      const name = getComputerTemplate(String(row.computer_profile))?.name ?? "prepared";
      return { kind: "fixed", cap: unavailable("prepared_fixed", `This ${name} preview has a fixed size of ${sizeOf(row)}. Hivra can't resize prepared computers yet.`) };
    }
    case "windows-my-server":
      return { kind: "fixed", cap: unavailable("windows_fixed", `This Windows computer uses ${sizeOf(row)}. Hivra can't resize Windows computers yet.`) };
    case "digitalocean":
      return { kind: "fixed", cap: unavailable("digitalocean_fixed", `DigitalOcean set this session's size (${sizeOf(row)}) when it was created, and it can't be changed.`) };
    case "my-cloud":
    case "my-cloud-agent":
      // Whether this server type can change comes from the provider-resize
      // API, which the Resources section asks; it shows the server's reason.
      return { kind: "hetzner-server-type", cap: operationInProgress(row) ? blocked("operation_in_progress", WAIT) : available };
    case "linux-sandbox":
      return { kind: "gvisor-limits", cap: operationInProgress(row) ? blocked("operation_in_progress", WAIT) : available };
    default:
      return { kind: "proxmox-envelope", cap: operationInProgress(row) ? blocked("operation_in_progress", WAIT) : available };
  }
}

const RESTORE_UNBOUND = "Restore points aren't available for this computer. It was created before Hivra recorded ownership checks.";

function restorePointsCap(row: ManageCapabilitiesRow, variant: ManageVariant, ctx: ManageCapabilitiesContext): ManageCapabilities["restorePoints"] {
  switch (variant) {
    case "prepared": return unavailable("prepared", "Prepared Windows and Omarchy computers don't have restore points yet.");
    case "windows-my-server": return unavailable("windows_my_server", "Restore points aren't available for Windows computers on your own server yet.");
    case "my-cloud":
    case "my-cloud-agent": return unavailable("my_cloud", "Restore points aren't available on My cloud computers yet.");
    case "linux-sandbox": return unavailable("linux_sandbox", "Restore points aren't available for Linux Sandboxes yet.");
    case "digitalocean": return unavailable("digitalocean", "DigitalOcean keeps this session's workspace. Hivra doesn't make restore points for it.");
    default: break;
  }
  const support = restorePointSupport(row);
  if (!support.supported) return unavailable(support.code, RESTORE_UNBOUND);
  if (ctx.agentAttached) {
    return { ...blocked("agent_attached", "Remove the agent from this computer first. A restore would roll the computer back under it."), maximum: 5 };
  }
  if (operationInProgress(row)) return { ...blocked("operation_in_progress", WAIT), maximum: 5 };
  return { state: "available", maximum: 5 };
}

function folderRecoveryCap(row: ManageCapabilitiesRow, variant: ManageVariant): ManageCap | null {
  // Folder recovery moves an Ubuntu desktop's Hivra folder; nothing else has one.
  if (variant !== "ubuntu-proxmox" || !(row.computer_profile == null || row.computer_profile === "ubuntu-desktop")) return null;
  if (folderRecoveryEligible(row)) return available;
  if (row.computer_profile !== "ubuntu-desktop" || row.computer_substrate !== "proxmox-kvm") {
    return unavailable("not_eligible", "Folder recovery isn't available for this computer.");
  }
  if (!hasOwnershipBinding(row)) return unavailable("not_bound", "Folder recovery isn't available for this computer. It was created before Hivra recorded ownership checks.");
  return blocked("not_ready", "Wait for this computer to finish setting up.");
}

const PRIVATE_NETWORK_REASON: Record<PrivateNetworkReason, string> = {
  not_eligible: "A private network is available on Ubuntu computers on Hivra Cloud and My server.",
  not_bound: "A private network isn't available for this computer. It was created before Hivra recorded ownership checks.",
  operation_in_progress: WAIT,
  not_running: "Start this computer to connect it.",
  not_ready: "Wait for this computer to finish starting.",
};

function privateNetworkCap(row: ManageCapabilitiesRow, isComputer: boolean): ManageCap | null {
  // Agents never join a private network themselves.
  if (!isComputer) return null;
  const reason = privateNetworkReason(row);
  if (!reason) return available;
  const text = PRIVATE_NETWORK_REASON[reason];
  return reason === "not_eligible" || reason === "not_bound" ? unavailable(reason, text) : blocked(reason, text);
}

function connectionServiceCap(row: ManageCapabilitiesRow, variant: ManageVariant): ManageCap | null {
  if (variant === "linux-sandbox" || variant === "digitalocean") return null;
  if (variant === "windows-my-server") return unavailable("windows_my_server", "Hivra can't update Windows computers on your own server yet.");
  switch (runtimeUpdateRefusal(row)) {
    case "deepseek": return unavailable("deepseek", "DeepSeek computers can't update their connection service here yet.");
    case "prepared": return unavailable("prepared", "Hivra can't update prepared Windows and Omarchy computers yet.");
    case "my-cloud": return unavailable("my_cloud", "Hivra can't update the connection service on My cloud computers yet.");
    default: break;
  }
  if (operationInProgress(row)) return blocked("operation_in_progress", WAIT);
  if (row.status !== "running") return blocked("not_running", "Start this computer to update it.");
  return available;
}

function agentCliFor(row: ManageCapabilitiesRow, variant: ManageVariant): ManageCapabilities["agentCli"] {
  if (variant !== "chat-agent") return null;
  if (row.computer_substrate != null && row.computer_substrate !== "proxmox-kvm") return null;
  if (row.type === "claude-code") return { name: "claude-code", vetted: AGENT_CLI_VERSIONS["claude-code"] };
  if (row.type === "codex") return { name: "codex", vetted: AGENT_CLI_VERSIONS.codex };
  return null;
}

/** Model & tools applies to agents whose gateway serves a model, tools or a browser. */
function hasModelSection(row: ManageCapabilitiesRow, variant: ManageVariant): boolean {
  if (variant !== "chat-agent" && variant !== "dashboard-agent" && variant !== "my-cloud-agent") return false;
  const def = catalogAgent(String(row.type));
  return Boolean(def && (def.cliKind === "claude" || def.cliKind === "codex" || def.browser || def.llm?.providers.includes("venice")));
}

function osOrAgentName(row: ManageCapabilitiesRow, isComputer: boolean): string {
  if (row.computer_substrate === "gvisor") return "Linux Sandbox";
  const def = catalogAgent(String(row.type));
  if (isComputer) {
    return getComputerTemplate(String(row.computer_profile))?.name ?? def?.name ?? "Computer";
  }
  return def?.name ?? String(row.type ?? "Agent");
}

function detailsFor(row: ManageCapabilitiesRow, variant: ManageVariant, isComputer: boolean, placementLabel: string): ManageDetail[] {
  const details: ManageDetail[] = [];
  if (typeof row.id === "string") details.push({ id: "hivra-id", label: "Hivra ID", value: row.id, copy: true });
  details.push({ id: "kind", label: isComputer ? "Operating system" : "Agent", value: osOrAgentName(row, isComputer) });
  details.push({ id: "placement", label: "Where it runs", value: placementLabel });
  const proxmox = row.computer_substrate == null || row.computer_substrate === "proxmox-kvm";
  if (proxmox && variant !== "digitalocean" && Number.isSafeInteger(row.vmid) && Number(row.vmid) > 0) {
    details.push({ id: "vmid", label: "VM ID (for support)", value: String(row.vmid), copy: true });
  }
  // The address is shown only where it is the owner's own network: a Hivra
  // Cloud computer's address is on Hivra's private host network and means
  // nothing outside it.
  if (typeof row.ip === "string" && row.ip) {
    if (variant === "my-cloud" || variant === "my-cloud-agent") details.push({ id: "ip", label: "Server IP", value: row.ip, copy: true });
    else if (row.deployment_mode === "self-managed" && proxmox) {
      details.push({ id: "ip", label: "Address on your host network", value: row.ip, copy: true });
    }
  }
  if (typeof row.created_at === "string" && row.created_at) details.push({ id: "created", label: "Created", value: row.created_at, format: "date" });
  if (typeof row.provisioned_at === "string" && row.provisioned_at) details.push({ id: "first-ready", label: "First ready", value: row.provisioned_at, format: "date" });
  return details;
}

const NOT_AVAILABLE_LABEL = {
  usage: "Live usage",
  forcePower: "Force off",
  restorePoints: "Restore points",
  folderRecovery: "Folder recovery",
  privateNetwork: "Private network",
  connectionServiceUpdate: "Connection service updates",
  power: "Start, stop and restart",
} as const;

export function manageCapabilitiesFor(row: ManageCapabilitiesRow, ctx: ManageCapabilitiesContext): ManageCapabilities {
  const def = catalogAgent(String(row.type));
  const isComputer = def?.surface === "computer" || Boolean(row.computer_profile);
  const variant = variantOf(row, isComputer);
  const placementId = computerPlacementFor({
    deployment_mode: typeof row.deployment_mode === "string" ? row.deployment_mode : null,
    computer_substrate: typeof row.computer_substrate === "string" ? row.computer_substrate : null,
  });
  const placement = { id: placementId, label: COMPUTER_PLACEMENT_LABEL[placementId] };

  const power = powerCaps(row, variant, ctx);
  const resize = resizeCap(row, variant);
  const usage = usageCap(row, variant, ctx);
  const restorePoints = restorePointsCap(row, variant, ctx);
  const folderRecovery = folderRecoveryCap(row, variant);
  const privateNetwork = privateNetworkCap(row, isComputer);
  const connectionServiceUpdate = connectionServiceCap(row, variant);
  const agentCli = agentCliFor(row, variant);
  const attachAgents = isComputer && variant === "ubuntu-proxmox" && ctx.attachAgents === true;
  const kind = isComputer ? "computer" : "agent";

  const notAvailable: ManageCapabilities["notAvailable"] = [];
  const note = (capability: string, cap: ManageCap | null) => {
    if (cap?.state === "unavailable") notAvailable.push({ capability, reason: cap.reason });
  };
  if (power.start.state === "unavailable") note(NOT_AVAILABLE_LABEL.power, power.start);
  // Listed once: where no power control works, the line above already says why.
  else note(NOT_AVAILABLE_LABEL.forcePower, power.forceStop);
  note(NOT_AVAILABLE_LABEL.usage, usage);
  note(NOT_AVAILABLE_LABEL.restorePoints, restorePoints);
  note(NOT_AVAILABLE_LABEL.folderRecovery, folderRecovery);
  note(NOT_AVAILABLE_LABEL.privateNetwork, privateNetwork);
  note(NOT_AVAILABLE_LABEL.connectionServiceUpdate, connectionServiceUpdate);

  const present: Record<ManageSectionId, boolean> = {
    overview: true,
    // Every computer Manage shows lists its agents; ComputerAgentsPanel offers
    // "Add an agent" where attach is available and an honest slot elsewhere.
    agents: isComputer && variant !== "linux-sandbox",
    model: hasModelSection(row, variant),
    resources: true,
    recovery: capShown(restorePoints) || capShown(folderRecovery),
    network: capShown(privateNetwork),
    updates: capShown(connectionServiceUpdate) || agentCli !== null,
    command: variant === "linux-sandbox",
    advanced: true,
  };

  return {
    version: 1,
    kind,
    variant,
    placement,
    sections: MANAGE_SECTION_IDS.filter((id) => present[id]),
    // Renaming is metadata only; the route accepts it for every kind.
    rename: available,
    power,
    resize,
    usage,
    restorePoints,
    folderRecovery,
    privateNetwork,
    connectionServiceUpdate,
    agentCli,
    attachAgents,
    // Every agent is told about its computer; a computer on its own is not.
    contract: kind === "agent",
    export: kind === "agent" && variant !== "digitalocean"
      ? row.status === "running" ? available : blocked("not_running", "Start this agent to export its data.")
      : null,
    // Deleting is always possible, including while a computer is being set up.
    destroy: { cap: available, extraWarning: row.computer_substrate === "provider-vm" ? "provider-resources" : null },
    details: detailsFor(row, variant, isComputer, placement.label),
    notAvailable,
  };
}
