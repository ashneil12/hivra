// Which of an owner's rows can be linked, and how Hivra reaches each end.
// Pure and client-safe: the routes decide with it and Manage shows its words.
//
// An agent (the source) gets its kit (key, CLI, skill) over the seed lane its
// own computer already uses: Proxmox (Hivra Cloud, My server) or the enrolled
// pin of a computer in the owner's own cloud. A computer (the target) runs the
// agent's commands over a lane that takes a command as data: the VMID-bound
// guest agent on Proxmox, or the gVisor adapter on a Linux sandbox.

import { getAgent } from "@/lib/hivra/agent-catalog";

export interface LinkRow {
  id: string;
  name?: string | null;
  type?: string | null;
  status?: string | null;
  computer_profile?: string | null;
  computer_substrate?: string | null;
  infrastructure_binding_token_enforced?: boolean | null;
}

export type SourceLane = "proxmox" | "provider";
export type TargetLane = "proxmox" | "gvisor";

export type LinkSide<L> = { ok: true; lane: L } | { ok: false; reason: string };

export function isComputerRow(row: LinkRow): boolean {
  return getAgent(String(row.type ?? ""))?.surface === "computer" || Boolean(row.computer_profile);
}

/** Whether this agent can be given computers, and over which lane its kit goes. */
export function linkSource(row: LinkRow): LinkSide<SourceLane> {
  if (isComputerRow(row)) return { ok: false, reason: "This is a computer, not an agent." };
  if (row.computer_substrate === "do-managed-session") {
    return { ok: false, reason: "Agents on DigitalOcean can't use your other computers yet." };
  }
  if (row.computer_substrate === "provider-vm") return { ok: true, lane: "provider" };
  if (row.computer_substrate === "proxmox-kvm" || !row.computer_substrate) return { ok: true, lane: "proxmox" };
  return { ok: false, reason: "This agent can't use your other computers yet." };
}

/** Whether agents can use this computer, and over which lane its commands run. */
export function linkTarget(row: LinkRow): LinkSide<TargetLane> {
  if (!isComputerRow(row)) return { ok: false, reason: "This is an agent, not a computer." };
  if (row.computer_substrate === "gvisor") return { ok: true, lane: "gvisor" };
  if (row.computer_profile === "windows") {
    return { ok: false, reason: "Agents can't use Windows computers yet." };
  }
  if (row.computer_substrate === "provider-vm") {
    return { ok: false, reason: "Agents can't use computers in your own cloud yet." };
  }
  if (row.computer_substrate === "proxmox-kvm") {
    // The binding tag is what proves the VM under this VMID is this computer.
    return row.infrastructure_binding_token_enforced === true
      ? { ok: true, lane: "proxmox" }
      : { ok: false, reason: "This computer was made before agents could use computers. Make a new one to link it." };
  }
  return { ok: false, reason: "Agents can't use this computer yet." };
}

/** Why a linked computer can't run a command right now, or null when it can. */
export function targetBusyReason(row: LinkRow): string | null {
  if (row.status === "running") return null;
  if (row.status === "stopped") return "This computer is stopped. Start it from Hivra, then try again.";
  if (row.status === "provisioning") return "This computer is still being set up.";
  return "This computer isn't running right now.";
}

/** Names reach agents' instruction files: one line, printable, bounded. */
export function linkLabel(name: string | null | undefined, fallback = "Computer"): string {
  const cleaned = String(name ?? "").replace(/[\u0000-\u001f\u007f-\u009f`<>|*_#\[\]\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return cleaned || fallback;
}

/** A short kind for the agent's list and Manage. */
export function computerKindLabel(row: LinkRow): string {
  if (row.computer_substrate === "gvisor" || row.computer_profile === "linux-terminal") return "Linux sandbox";
  if (row.computer_profile === "omarchy") return "Omarchy desktop";
  if (row.computer_profile === "windows") return "Windows";
  if (row.computer_profile === "ubuntu-desktop" || row.type === "linux-desktop") return "Ubuntu desktop";
  return "Linux computer";
}
