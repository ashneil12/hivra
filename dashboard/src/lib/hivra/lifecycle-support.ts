// What each kind of Hivra computer supports, as one set of predicates.
//
// The lifecycle action route, the private-access and folder-recovery services
// and the Manage capability map (manage-capabilities.ts) all read these, so
// what Manage offers cannot drift from what the server will do. Pure and
// isomorphic: no server imports, no I/O.

/** The stored-row fields these predicates read. Values are untrusted. */
export interface LifecycleSupportRow {
  type?: unknown;
  computer_profile?: unknown;
  computer_substrate?: unknown;
  deployment_mode?: unknown;
  infrastructure_binding_token_enforced?: unknown;
  status?: unknown;
  desired_state?: unknown;
  operation_id?: unknown;
  operation_kind?: unknown;
  vmid?: unknown;
  ip?: unknown;
}

// ── Action lists per computer kind ─────────────────────────────────────────

/** DigitalOcean sessions: Start resumes, Stop pauses, Delete removes. */
export const DO_SESSION_ACTIONS = { start: "resume", stop: "pause", delete: "delete" } as const;
export type DoSessionRequestAction = keyof typeof DO_SESSION_ACTIONS;

export function doSessionActionFor(action: string): (typeof DO_SESSION_ACTIONS)[DoSessionRequestAction] | null {
  return Object.prototype.hasOwnProperty.call(DO_SESSION_ACTIONS, action)
    ? DO_SESSION_ACTIONS[action as DoSessionRequestAction]
    : null;
}

/** Linux Sandbox (gVisor): no restart, restore points or in-place update. */
export const GVISOR_ACTIONS = ["start", "stop", "resize", "delete"] as const;
export type GvisorAction = (typeof GVISOR_ACTIONS)[number];

export function isGvisorAction(action: string): action is GvisorAction {
  return (GVISOR_ACTIONS as readonly string[]).includes(action);
}

/**
 * Force off and Force restart: switch the computer off at once (qm stop), not
 * a guest shutdown. They reuse the stop and restart operation kinds, so they
 * take the same lease and settle through the same reconciler paths. Proxmox
 * computers (Hivra Cloud, My server, prepared) only; a My cloud computer is
 * refused (PROVIDER_REFUSED_ACTIONS) because the Hetzner power client never
 * forces power.
 */
export const FORCE_POWER_ACTIONS = ["force_stop", "force_restart"] as const;
export type ForcePowerAction = (typeof FORCE_POWER_ACTIONS)[number];

export function isForcePowerAction(action: string): action is ForcePowerAction {
  return (FORCE_POWER_ACTIONS as readonly string[]).includes(action);
}

/** Prepared Windows and Omarchy computers run their own power-only adapter. */
export const PREPARED_ACTIONS = ["start", "stop", "restart", ...FORCE_POWER_ACTIONS] as const;
export type PreparedAction = (typeof PREPARED_ACTIONS)[number];

export function isPreparedAction(action: string): action is PreparedAction {
  return (PREPARED_ACTIONS as readonly string[]).includes(action);
}

/** Everything the Proxmox lifecycle branch accepts. */
export const PROXMOX_ACTIONS = ["stop", "start", "restart", "update_runtime", "resize", "snapshot", "restore", ...FORCE_POWER_ACTIONS] as const;
export type ProxmoxAction = (typeof PROXMOX_ACTIONS)[number];

export function isProxmoxAction(action: string): action is ProxmoxAction {
  return (PROXMOX_ACTIONS as readonly string[]).includes(action);
}

/**
 * Proxmox actions a My cloud (Hetzner) computer refuses before any provider
 * call, with the exact message the route returns. Resizing goes through the
 * separate provider-resize flow instead.
 */
export const PROVIDER_REFUSED_ACTIONS = {
  update_runtime: "Runtime updates for allocated provider computers are not supported yet. Your computer and data are unchanged.",
  resize: "Resizing an allocated Hetzner computer is not supported yet. Its original size and data are retained.",
  snapshot: "Restore points for allocated provider computers are not supported yet. The original computer and data are unchanged.",
  restore: "Restore points for allocated provider computers are not supported yet. The original computer and data are unchanged.",
  force_stop: "Hivra can't force a My cloud computer off. Use Stop, or use your provider's console to force it off. Nothing was changed.",
  force_restart: "Hivra can't force a My cloud computer to restart. Use Restart, or use your provider's console to force it off. Nothing was changed.",
} as const;
export type ProviderRefusedAction = keyof typeof PROVIDER_REFUSED_ACTIONS;

export function providerRefusalFor(action: string): string | null {
  return Object.prototype.hasOwnProperty.call(PROVIDER_REFUSED_ACTIONS, action)
    ? PROVIDER_REFUSED_ACTIONS[action as ProviderRefusedAction]
    : null;
}

// ── Kinds ──────────────────────────────────────────────────────────────────

/** Windows and Omarchy rows never enter the Ubuntu provisioner's lifecycle. */
export function isPreparedProfile(row: LifecycleSupportRow): boolean {
  return row.computer_profile === "omarchy" || row.computer_profile === "windows";
}

/**
 * A Windows computer installed from the owner's own ISO on their own Proxmox
 * host. It has no lifecycle adapter yet: the route refuses every power,
 * resize and restore action for it.
 */
export function isWindowsOnMyServer(row: LifecycleSupportRow): boolean {
  return row.computer_profile === "windows" && row.deployment_mode === "self-managed"
    && (row.computer_substrate == null || row.computer_substrate === "proxmox-kvm");
}

/** Only exact "true" counts: legacy rows carry false or no value. */
export function hasOwnershipBinding(row: LifecycleSupportRow): boolean {
  return row.infrastructure_binding_token_enforced === true;
}

function hasOperation(row: LifecycleSupportRow): boolean {
  return row.operation_id != null || row.operation_kind != null;
}

// ── Restore points ─────────────────────────────────────────────────────────

export type RestorePointSupport =
  | { supported: true }
  | { supported: false; code: "not_proxmox" | "prepared" | "not_bound" };

/**
 * Same-host restore points: listed only for Proxmox computers (the snapshots
 * GET), and created or restored only when the row carries its ownership
 * binding (the action route answers 409 otherwise).
 */
export function restorePointSupport(row: LifecycleSupportRow): RestorePointSupport {
  if (row.computer_substrate !== "proxmox-kvm") return { supported: false, code: "not_proxmox" };
  if (isPreparedProfile(row)) return { supported: false, code: "prepared" };
  if (!hasOwnershipBinding(row)) return { supported: false, code: "not_bound" };
  return { supported: true };
}

// ── Private network (Tailscale / Headscale) ────────────────────────────────

/**
 * Why a computer can't use a private network right now, or null when it can.
 * not_eligible and not_bound never change for a computer; the others clear
 * once it is running with no operation in progress.
 */
export type PrivateNetworkReason = "not_eligible" | "not_bound" | "operation_in_progress" | "not_running" | "not_ready";

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** The half of private-network eligibility that never changes for a computer. */
export function privateNetworkStaticReason(row: LifecycleSupportRow): "not_eligible" | "not_bound" | null {
  if (row.type !== "linux-desktop"
    || !(row.computer_profile == null || row.computer_profile === "ubuntu-desktop")
    || row.computer_substrate !== "proxmox-kvm") return "not_eligible";
  if (!hasOwnershipBinding(row)) return "not_bound";
  return null;
}

export function privateNetworkReason(row: LifecycleSupportRow): PrivateNetworkReason | null {
  const fixed = privateNetworkStaticReason(row);
  if (fixed) return fixed;
  if (hasOperation(row)) return "operation_in_progress";
  if (row.status !== "running" || row.desired_state !== "running") return "not_running";
  if (!Number.isSafeInteger(row.vmid) || Number(row.vmid) < 100
    || typeof row.ip !== "string" || !IPV4.test(row.ip)) return "not_ready";
  return null;
}

// ── Folder recovery ────────────────────────────────────────────────────────

/** Folder export and import: enrolled Ubuntu desktops on Proxmox only. */
export function folderRecoveryEligible(row: LifecycleSupportRow): boolean {
  return row.type === "linux-desktop" && row.computer_profile === "ubuntu-desktop"
    && row.computer_substrate === "proxmox-kvm" && hasOwnershipBinding(row)
    && Boolean(row.vmid) && typeof row.ip === "string";
}

// ── In-place connection-service update ─────────────────────────────────────

export type RuntimeUpdateRefusal = "digitalocean" | "linux-sandbox" | "prepared" | "my-cloud" | "deepseek";

/**
 * Why update_runtime is refused for this row, before any lease or host call,
 * or null when the route accepts it. The order is the route's: DigitalOcean
 * and gVisor branches first, then the DeepSeek refusal (a DeepSeek guest also
 * runs a native service the gateway-only updater cannot replace), then the
 * prepared and My cloud branches.
 */
export function runtimeUpdateRefusal(row: LifecycleSupportRow): RuntimeUpdateRefusal | null {
  if (row.computer_substrate === "do-managed-session") return "digitalocean";
  if (row.computer_substrate === "gvisor") return "linux-sandbox";
  if (row.type === "deepseek-harness") return "deepseek";
  if (isPreparedProfile(row)) return "prepared";
  if (row.computer_substrate === "provider-vm") return "my-cloud";
  return null;
}
