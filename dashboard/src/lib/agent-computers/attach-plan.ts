// Adding an agent to a computer its owner already has (design 5.1, 5.2, 5.8).
// Pure and client-safe. One set of facts feeds the access gate, the Review,
// the Computer Contract the attached agent receives, and the computer page's
// Chat tab, so what the owner approves, what the agent is told and what the
// owner can open cannot drift apart (T19).

import { COMPUTER_CONTRACT_TEMPLATE_VERSION, contractLabel, type ComputerContractInput } from "./computer-contract";
import { computerPlacementFor, type ComputerPlacementSubject } from "./agent-surfaces";

/** The first accepted pair: Codex on an Ubuntu Desktop computer on Proxmox. */
export const ATTACH_RUNTIME_ID = "codex" as const;
export const ATTACH_RUNTIME_NAME = "Codex";
/** The pinned stager (stage-attached-codex.py) every attach installs with. */
export const ATTACH_INSTALLER_SHA256 = "77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375";
export const ATTACH_NOT_AVAILABLE = "Not available to add to an existing computer yet";

/**
 * The honest pair line wherever an agent is put on a computer the owner
 * already has: it is always a new agent, and nothing else changes.
 */
export function attachPairLine(computerName: string, runtimeName = "Codex"): string {
  return `Adds a new ${runtimeName} to ${computerName}. Your other agents stay as they are.`;
}

export interface AttachGrants { workspace: boolean }
/** The access gate's defaults: ~/Hivra read and write on. */
export const DEFAULT_ATTACH_GRANTS: Readonly<AttachGrants> = Object.freeze({ workspace: true });

export function normalizeAttachGrants(value: unknown): AttachGrants | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const workspace = (value as { workspace?: unknown }).workspace;
  return keys.length === 1 && keys[0] === "workspace" && typeof workspace === "boolean" ? { workspace } : null;
}

/**
 * The reviewed grant policy, as data. Its digest is part of every intent, so a
 * record says which rows and defaults the owner was shown.
 */
export const ATTACH_GRANT_POLICY = Object.freeze({
  version: 1,
  runtime: ATTACH_RUNTIME_ID,
  rows: Object.freeze([
    ["workspace", "toggle", "on"],
    ["ownUser", "locked", "on"],
    ["internet", "locked", "on"],
    ["localNetwork", "always", "off"],
    ["chromeProfile", "notAvailable", "off"],
    ["desktopControl", "notAvailable", "off"],
    ["sudo", "notAvailable", "off"],
    ["personalHome", "never", "off"],
  ] as const),
});

// ── Eligibility ────────────────────────────────────────────────────────────

export interface AttachComputerSubject extends ComputerPlacementSubject {
  type: string;
  status?: string | null;
  computer_profile?: string | null;
  computer_substrate?: string | null;
  infrastructure_binding_token_enforced?: boolean | null;
}

/**
 * Whether this computer can take the first accepted pair at all. Every other
 * computer says "Not available to add to an existing computer yet"; the server
 * decides again with the live row and the database (5.6).
 */
export function attachSupported(subject: AttachComputerSubject): boolean {
  return subject.type === "linux-desktop"
    && (subject.computer_profile ?? "ubuntu-desktop") === "ubuntu-desktop"
    && subject.computer_substrate === "proxmox-kvm"
    && subject.infrastructure_binding_token_enforced !== false;
}

// ── The access gate (5.8) ──────────────────────────────────────────────────

export type AttachAccessState = "on" | "off" | "locked-on" | "always-off" | "not-available" | "never" | "shown";

export interface AttachAccessRow {
  id: "workspace" | "ownUser" | "internet" | "localNetwork" | "chromeProfile" | "desktopControl" | "sudo" | "personalHome" | "resources";
  label: string;
  state: AttachAccessState;
  /** Only ~/Hivra can be switched in this release. */
  toggle: boolean;
  copy: string;
}

export interface AttachComputerFacts {
  name: string;
  cpu: number;
  ramGb: number;
  deploymentMode?: string | null;
}

function amount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** min(2 GB, half the computer's memory), whole MB, at least 512 MB. */
export function attachedMemoryMaxMb(computerRamGb: number): number {
  const half = Math.floor((Number(computerRamGb) * 1024) / 2);
  return Math.max(512, Math.min(2048, Number.isFinite(half) ? half : 512));
}

export function attachedMemoryLabel(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024} GB` : `${amount(Math.round((mb / 1024) * 10) / 10)} GB`;
}

export const ATTACH_WORKSPACE_WARNING = "Shared with your Desktop and Files. Codex can read everything in it, including any keys or .env files you keep there, and can change or delete files. Anything Codex puts there can run programs as you when you use it in your Terminal, an editor or a desktop app. Even a plain git status in a repository Codex changed can do this.";

export function attachAccessRows(grants: AttachGrants, computer: AttachComputerFacts): AttachAccessRow[] {
  const memoryMax = attachedMemoryLabel(attachedMemoryMaxMb(computer.ramGb));
  return [
    { id: "workspace", label: "Your Hivra folder (~/Hivra), read and write", state: grants.workspace ? "on" : "off", toggle: true,
      copy: ATTACH_WORKSPACE_WARNING },
    { id: "ownUser", label: "Its own user on this computer", state: "locked-on", toggle: false, copy: "Codex runs as a separate user, not as you." },
    { id: "internet", label: "Internet", state: "locked-on", toggle: false,
      copy: "Codex needs the internet to reach ChatGPT. It can send anything it can read to the internet." },
    { id: "localNetwork", label: "This computer's other services and local network", state: "always-off", toggle: false,
      copy: "Codex can't reach your terminal, your desktop session, or other devices on this computer's network." },
    { id: "chromeProfile", label: "Chrome profile", state: "not-available", toggle: false, copy: "Codex can't use a browser on this computer yet." },
    { id: "desktopControl", label: "Desktop control", state: "not-available", toggle: false, copy: "Codex can't see or control your desktop." },
    { id: "sudo", label: "Administrator (sudo)", state: "not-available", toggle: false,
      copy: "With administrator access Codex could read your personal files and undo every limit above." },
    { id: "personalHome", label: "Your personal home folder", state: "never", toggle: false, copy: "Never offered." },
    { id: "resources", label: "Resources", state: "shown", toggle: false,
      copy: `Codex shares this computer's ${amount(computer.cpu)} CPU and ${amount(computer.ramGb)} GB. It can use up to ${memoryMax} of memory, and your desktop has priority.` },
  ];
}

// ── The Review (5.8) ───────────────────────────────────────────────────────

export interface AttachReview {
  title: string;
  lines: string[];
  isolation: string;
  technical: { isolationClass: "shared-kernel"; installerSha256: string; servicePolicySha256: string };
  button: string;
}

export function attachReview(input: {
  computerName: string;
  grants: AttachGrants;
  deploymentMode?: string | null;
  servicePolicySha256: string;
}): AttachReview {
  const computer = contractLabel(input.computerName, 64, "this computer");
  const myServer = input.deploymentMode === "self-managed";
  const can = input.grants.workspace
    ? "Codex can: read and write ~/Hivra, use its own terminal, reach the internet."
    : "Codex can: use its own terminal and reach the internet. It has no shared folder.";
  const lines = [
    myServer
      ? "Installs Codex as a separate user on this computer. Nothing is bought."
      : "Installs Codex as a separate user on this computer. Nothing is bought. Codex counts as one of your plan's agents.",
    can,
    "Codex can't: see your personal home folder, use sudo, control your desktop or browser, or reach this computer's other services.",
    ...(input.grants.workspace ? ["Before you run Git, scripts or build tools in ~/Hivra yourself, check what Codex changed. They run as you, not as Codex. Hivra's Files view only shows and saves files. It never runs them."] : []),
    "After it installs, sign in to ChatGPT in the Chat tab.",
    "Remove it any time. Your files in ~/Hivra stay, including anything Codex added, such as scripts or Git settings. Codex's sign-in and chat history on this computer are deleted.",
  ];
  return {
    title: `Add Codex to ${JSON.stringify(computer)}`,
    lines,
    isolation: "Isolation: a separate user on this computer. That is weaker than giving Codex its own computer.",
    technical: { isolationClass: "shared-kernel", installerSha256: ATTACH_INSTALLER_SHA256, servicePolicySha256: input.servicePolicySha256 },
    button: "Add Codex to this computer",
  };
}

/** Change access has its own review; turning ~/Hivra off repeats the warning. */
export function attachAccessChangeReview(input: { computerName: string; from: AttachGrants; to: AttachGrants }): { title: string; lines: string[]; button: string } {
  const computer = contractLabel(input.computerName, 64, "this computer");
  const lines = input.to.workspace
    ? ["Codex will be able to read and write ~/Hivra again. " + ATTACH_WORKSPACE_WARNING,
      "Codex stops while its access changes, then starts again."]
    : ["Codex will no longer see ~/Hivra. Files Codex added to ~/Hivra stay, and can still run as you if you run them.",
      "Codex stops while its access changes, then starts again."];
  return { title: `Change what Codex can use on ${JSON.stringify(computer)}`, lines, button: input.to.workspace ? "Share ~/Hivra with Codex" : "Stop sharing ~/Hivra" };
}

/** Remove has its own review (5.8). */
export function attachRemoveReview(input: { computerName: string; deploymentMode?: string | null }): { title: string; lines: string[]; button: string } {
  const computer = contractLabel(input.computerName, 64, "this computer");
  return {
    title: `Remove Codex from ${JSON.stringify(computer)}`,
    lines: [
      "Stops Codex and deletes its user, its sign-in and its chat history on this computer.",
      "Files Codex added to ~/Hivra stay after it's removed, and can still run as you if you run them.",
      ...(input.deploymentMode === "self-managed" ? [] : ["This frees one of your plan's agents."]),
    ],
    button: "Remove Codex",
  };
}

// ── The attached agent's Computer Contract ─────────────────────────────────

/** The attached agent's own surfaces: its user chats with it on the computer's page. */
export const ATTACHED_AGENT_SURFACES = ["chat"] as const;

export function attachedContractInput(input: {
  agentName: string;
  computer: AttachComputerFacts & ComputerPlacementSubject;
  installationId: string;
  grants: AttachGrants;
}): ComputerContractInput {
  const placement = computerPlacementFor(input.computer);
  if (placement !== "hivra-cloud" && placement !== "my-server") throw new Error("Attach runs only on a Proxmox computer");
  const cpu = Number(input.computer.cpu) > 0 ? Number(input.computer.cpu) : 1;
  const memoryGb = Number(input.computer.ramGb) > 0 ? Number(input.computer.ramGb) : 1;
  return {
    templateVersion: COMPUTER_CONTRACT_TEMPLATE_VERSION,
    runtime: "codex",
    agentLabel: contractLabel(input.agentName, 60, "your agent"),
    placement,
    resources: { cpu, memoryGb, cpuMax: cpu, memoryMaxGb: memoryGb },
    surfaces: [...ATTACHED_AGENT_SURFACES],
    browser: "none",
    tools: "none",
    attached: {
      computerLabel: contractLabel(input.computer.name, 64, "this computer"),
      installationId: input.installationId,
      account: `hva_${input.installationId.replaceAll("-", "").slice(0, 24)}`,
      workspace: input.grants.workspace,
      memoryMaxMb: attachedMemoryMaxMb(memoryGb),
    },
  };
}

// ── Progress (5.8): observed receipts only ─────────────────────────────────

export type AttachmentPhase = "claimed" | "dispatched" | "cancelled" | "attached" | "failed" | "detached";
export interface AttachmentReceipts {
  accepted: string | null;
  staged: string | null;
  started: string | null;
  chatReady: string | null;
}

export interface AttachProgressStep { id: "accepted" | "installed" | "started" | "ready"; label: string; at: string | null }

/** Each line appears only with its receipt. Nothing is inferred from time. */
export function attachProgressSteps(receipts: AttachmentReceipts): AttachProgressStep[] {
  return [
    { id: "accepted", label: "Request accepted", at: receipts.accepted },
    { id: "installed", label: "Codex installed", at: receipts.staged },
    { id: "started", label: "Codex started", at: receipts.started },
    { id: "ready", label: "Chat is ready", at: receipts.chatReady },
  ];
}
