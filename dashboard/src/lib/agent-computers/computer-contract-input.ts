// Builds the Computer Contract's input from a stored agent row, and says how
// (or whether) Hivra can deliver it. Pure and client-safe: the agent route,
// Manage and the parity tests call the same function.

import { getAgent as catalogAgent } from "@/lib/hivra/agent-catalog";
import { catalogToolsUnavailableReason } from "@/lib/hivra/catalog-tool-availability";
import {
  agentSurfacesFor,
  computerPlacementFor,
  type AgentSurfaceSubject,
  type ComputerPlacementSubject,
} from "./agent-surfaces";
import {
  COMPUTER_CONTRACT_TEMPLATE_VERSION,
  contractLabel,
  type ComputerContractInput,
  type ContractRuntime,
} from "./computer-contract";

export interface ComputerContractSubject extends AgentSurfaceSubject, ComputerPlacementSubject {
  name?: string | null;
  cpu?: number | null;
  ram?: number | null;
  cpu_max?: number | null;
  ram_max?: number | null;
}

/** How a contract reaches the agent. */
export type ComputerContractChannel =
  /** Hivra Cloud and My server: the host-to-guest seed lane, read back in the same call. */
  | "proxmox-seed"
  /** My cloud: the same guest program over the enrolled provider pin, read back in the same call. */
  | "provider-seed"
  /** DigitalOcean: a visible first "Hivra setup" message in the transcript. */
  | "do-setup-message";

export const COMPUTER_CONTRACT_CHANNELS = ["proxmox-seed", "provider-seed", "do-setup-message"] as const satisfies readonly ComputerContractChannel[];

export type ComputerContractPlan =
  | { status: "deliverable"; channel: ComputerContractChannel; input: ComputerContractInput }
  /** No contract applies: a computer without an agent, or a runtime that
   * reads its own instructions rather than ~/system-prompt.md. */
  | { status: "not_applicable"; reason: "computer" | "own_instructions" };

function positive(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function runtimeFor(subject: ComputerContractSubject): ContractRuntime | null {
  if (subject.computer_substrate === "do-managed-session") {
    return subject.type === "claude-code" || subject.type === "codex" || subject.type === "hermes" ? subject.type : null;
  }
  // Claude Code and Codex load ~/system-prompt.md through ~/CLAUDE.md and
  // ~/AGENTS.md. Dashboard runtimes (Aeon, OpenClaw, Agent Zero, DeepSeek) have
  // no such file; the provisioner removes it (ATT-14).
  return subject.type === "claude-code" || subject.type === "codex" ? subject.type : null;
}

export function computerContractPlanFor(subject: ComputerContractSubject): ComputerContractPlan {
  const def = catalogAgent(subject.type);
  if (def?.surface === "computer" || def?.resourceKind === "computer" || subject.computer_substrate === "gvisor") {
    return { status: "not_applicable", reason: "computer" };
  }
  const runtime = runtimeFor(subject);
  if (!runtime) return { status: "not_applicable", reason: "own_instructions" };
  const placement = computerPlacementFor(subject);
  const cpu = positive(subject.cpu, 1), memoryGb = positive(subject.ram, 1);
  const digitalOcean = placement === "digitalocean";
  const input: ComputerContractInput = {
    templateVersion: COMPUTER_CONTRACT_TEMPLATE_VERSION,
    runtime,
    // Stored already sanitized, so a rename that changes nothing visible (a
    // trailing space) does not mint a new revision.
    agentLabel: contractLabel(subject.name, 60, "your agent"),
    placement,
    resources: {
      cpu,
      memoryGb,
      cpuMax: positive(subject.cpu_max, cpu),
      memoryMaxGb: positive(subject.ram_max, memoryGb),
    },
    // The same decision that draws the tabs; the contract never names a
    // surface the owner cannot open.
    surfaces: agentSurfacesFor(subject),
    browser: !digitalOcean && def?.browser ? "toggle" : "none",
    tools: digitalOcean ? "none" : catalogToolsUnavailableReason(subject.computer_substrate) ? "mcp" : "catalog",
  };
  if (digitalOcean) return { status: "deliverable", channel: "do-setup-message", input };
  if (placement === "my-cloud") return { status: "deliverable", channel: "provider-seed", input };
  return { status: "deliverable", channel: "proxmox-seed", input };
}

/** Canonical JSON: fixed key order, so equal inputs always hash equally. */
export function canonicalComputerContractInput(input: ComputerContractInput): string {
  return JSON.stringify({
    templateVersion: input.templateVersion,
    runtime: input.runtime,
    agentLabel: input.agentLabel,
    placement: input.placement,
    resources: {
      cpu: input.resources.cpu,
      memoryGb: input.resources.memoryGb,
      cpuMax: input.resources.cpuMax,
      memoryMaxGb: input.resources.memoryMaxGb,
    },
    surfaces: [...input.surfaces],
    browser: input.browser,
    tools: input.tools,
    // Only attached inputs carry this key, so an own-computer input keeps the
    // exact canonical bytes (and digest) it had before attach existed.
    ...(input.attached ? { attached: {
      computerLabel: input.attached.computerLabel,
      installationId: input.attached.installationId,
      account: input.attached.account,
      workspace: input.attached.workspace,
      memoryMaxMb: input.attached.memoryMaxMb,
    } } : {}),
  });
}
