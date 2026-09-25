import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { ATTACHED_HELPERS } from "./attachment-service-units";
import { logAttachmentTransportFailure } from "./attachment-transport-diagnostic";
import { buildAttachmentHostStepScript, parseAttachmentTargetRefusal, parseGuestStepRefusal, snapshotAttachmentObservationTarget,
  type AttachmentTargetRefusal } from "./attachment-host-observation";

// The attached agent's guest steps after staging: activate, observe, change
// access, remove (design 5.5). One pinned runner and one pinned lifecycle
// program travel with the three pinned helpers over the VMID-bound guest exec,
// the same fence as staging. No private-IP SSH, no caller path or command.

export const ATTACHED_AGENT_PROGRAM_SHA256 = "ea761a6df567b033b7ae83158d845777f024c0b7a27843f311db71bebeb54551";
export const ATTACHED_AGENT_RUNNER_SHA256 = "c90d2cb65a2323d38c43fcbaecccea0084608b574b62c5b2b29f82af0ab8d90f";
const ASSETS = {
  agent: { file: "attached-agent.py", digest: ATTACHED_AGENT_PROGRAM_SHA256 },
  workspace: { file: ATTACHED_HELPERS[0].file, digest: ATTACHED_HELPERS[0].sha256 },
  network: { file: ATTACHED_HELPERS[1].file, digest: ATTACHED_HELPERS[1].sha256 },
  relay: { file: ATTACHED_HELPERS[2].file, digest: ATTACHED_HELPERS[2].sha256 },
} as const;
type Asset = keyof typeof ASSETS | "runner";
const RUNNER = { file: "run-attached-agent-bundle.py", digest: ATTACHED_AGENT_RUNNER_SHA256 };
const MAX_BUNDLE_BYTES = 512 * 1024;

export type AttachedAgentAction = "activate" | "observe" | "access" | "remove" | "state";
// Activation starts units, runs the network enforcement probe (up to 3 min)
// and waits for Chat (90 s) and the gateway (60 s). Remove sweeps the disk.
export const ATTACHED_AGENT_TIMEOUTS: Readonly<Record<AttachedAgentAction, { guestSeconds: number; hostMs: number }>> = Object.freeze({
  activate: Object.freeze({ guestSeconds: 540, hostMs: 620_000 }),
  observe: Object.freeze({ guestSeconds: 60, hostMs: 120_000 }),
  access: Object.freeze({ guestSeconds: 300, hostMs: 380_000 }),
  remove: Object.freeze({ guestSeconds: 480, hostMs: 560_000 }),
  state: Object.freeze({ guestSeconds: 60, hostMs: 120_000 }),
});

const readSource = (file: string): Buffer => readFileSync(path.resolve(process.cwd(), "provisioner", file));

/** The bundle: the runner program and its stdin. Every source is pinned. */
export function buildAttachedAgentBundle(packet: Record<string, unknown>, reader: (file: string) => Buffer = readSource) {
  const action = packet.action;
  if (typeof action !== "string" || !Object.hasOwn(ATTACHED_AGENT_TIMEOUTS, action)) throw new Error("Invalid attached agent action.");
  const load = (name: Asset) => {
    const pin = name === "runner" ? RUNNER : ASSETS[name];
    const source = Buffer.from(reader(pin.file));
    if (createHash("sha256").update(source).digest("hex") !== pin.digest) {
      throw new Error("Attached agent assets do not match the reviewed revision.");
    }
    return source;
  };
  const assets = Object.fromEntries((Object.keys(ASSETS) as Array<keyof typeof ASSETS>).map((name) => [name, load(name).toString("base64")]));
  const stdin = JSON.stringify({ version: 1, packet, assets });
  if (Buffer.byteLength(stdin, "utf8") > MAX_BUNDLE_BYTES) throw new Error("Attached agent bundle exceeds its transport limit.");
  return { program: load("runner").toString("utf8"), stdin };
}

export interface AttachedAgentTarget {
  operationId: string;
  computerId: string;
  sourceId: string;
  vmid: number;
  guestIp: string;
  bindingTag: string;
  architecture: "x86_64" | "aarch64";
}

/** The host script and, as its own stdin stream, the bundle: at about 150 KB
 * the bundle is over the host's argument limit, so it never goes inside the
 * script. Run them with runProxmoxHostScriptWithStdin. */
export function buildAttachedAgentHostScript(action: AttachedAgentAction, inputTarget: AttachedAgentTarget,
  packet: Record<string, unknown>): { script: string; stdin: string } {
  const target = snapshotAttachmentObservationTarget(inputTarget);
  const bundle = buildAttachedAgentBundle({ ...packet, action });
  // No private-IP SSH fallback. The host lock covers the VM check and the start only.
  return { script: buildAttachmentHostStepScript(target, bundle.program, ATTACHED_AGENT_TIMEOUTS[action].guestSeconds), stdin: bundle.stdin };
}

// ── Results ─────────────────────────────────────────────────────────────────

const Id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
export const AttachedActivationObservation = z.object({
  version: z.literal(1),
  state: z.enum(["process_running", "service_inactive", "activation_unresolved", "native_protocol_available"]),
  journalPhase: z.enum(["preparing", "start_requested", "service_started", "start_failed"]),
  operationId: Id, activationId: Id, installationId: Id, bootId: Id, serviceDefinitionSha256: Digest,
  mainPid: z.number().int().min(2).max(2147483647).optional(),
}).strict();
const ContractReadback = z.object({ sha256: Digest, checked: z.boolean() }).strict();
const ActivationResult = z.object({
  observation: AttachedActivationObservation,
  contract: ContractReadback.nullable(),
  failure: z.enum(["network_not_enforced", "chat_not_ready", "gateway_unreachable", "start_failed"]).optional(),
}).strict();
const AccessResult = z.object({
  version: z.literal(1), operationId: Id, installationId: Id,
  state: z.enum(["ready", "restored", "refused", "unresolved"]),
  grants: z.object({ workspace: z.boolean() }).strict().optional(),
  viewMounted: z.boolean().optional(),
  contract: ContractReadback.nullable().optional(),
  reason: z.string().max(64).optional(),
}).strict();
const RemoveResult = z.object({
  version: z.literal(1), operationId: Id, installationId: Id,
  state: z.enum(["removed", "unresolved"]),
  workspaceTouched: z.literal(false),
  viewUnmounted: z.boolean().optional(), networkRemoved: z.boolean().optional(), unitsRemoved: z.boolean().optional(),
  homeRemoved: z.boolean().optional(), accountRemoved: z.boolean().optional(), stagingCleared: z.boolean().optional(),
  leftoverFiles: z.number().int().min(0).max(1).optional(),
  reason: z.string().max(64).optional(),
}).strict();
const StateResult = z.object({
  version: z.literal(1), operationId: Id, installationId: Id, accountPresent: z.boolean(), unitsPresent: z.boolean(),
  workspace: z.boolean().nullable(), viewMounted: z.boolean(), agentActive: z.boolean(), chatReady: z.boolean(),
}).strict();
export type AttachedActivationResult = z.infer<typeof ActivationResult>;
export type AttachedStateResult = z.infer<typeof StateResult>;
export type AttachedAccessResult = z.infer<typeof AccessResult>;
export type AttachedRemoveResult = z.infer<typeof RemoveResult>;

/** Exactly one result line from the pinned runner; anything else is unresolved. */
export function parseAttachedAgentResult(action: AttachedAgentAction, stdout: string):
  AttachedActivationResult | AttachedAccessResult | AttachedRemoveResult | AttachedStateResult | null {
  const lines = stdout.split("\n").filter((line) => line.startsWith("HIVRA_ATTACHED_AGENT_V1 "));
  if (lines.length !== 1 || lines[0].length > 32 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(lines[0].slice("HIVRA_ATTACHED_AGENT_V1 ".length)); } catch { return null; }
  const schema = action === "activate" || action === "observe" ? ActivationResult : action === "access" ? AccessResult
    : action === "state" ? StateResult : RemoveResult;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── Transport ───────────────────────────────────────────────────────────────

/** What run-attached-agent-bundle.py names when the lifecycle program raised (step_refused: anything else). */
export const ATTACHED_AGENT_REFUSALS = ["computer_update_required", "workspace_path_not_plain", "detach_mount_found",
  "computer_restarted", "staged_installation_mismatch", "service_definition_mismatch", "gateway_group_has_members",
  "step_refused"] as const;
export type AttachedAgentRefusal = typeof ATTACHED_AGENT_REFUSALS[number];

type Dependencies = { resolveContext: typeof resolveHivraAgentExecutionContext; runHostScript: typeof runProxmoxHostScriptWithStdin };
export type AttachedAgentHostResult =
  | { ok: true; result: AttachedActivationResult | AttachedAccessResult | AttachedRemoveResult | AttachedStateResult }
  | { ok: false; code: "invalid_target" | "authority_unavailable" | "transport_failed" | "invalid_result" }
  | { ok: false; code: "target_refused"; reason: AttachmentTargetRefusal }
  /** The program ran in the VM and ended with this refusal: nothing is left to wait for. */
  | { ok: false; code: "guest_refused"; reason: AttachedAgentRefusal };

/** Internal transport only. The caller must hold the step's database dispatch
 * (activate, access, remove) or ask for a read-only observe. Never retried
 * blindly: a lost answer is followed by observe. */
export async function executeAttachedAgentStep(
  ownerId: string, agent: RemoteDesktopAgentRow, action: AttachedAgentAction, target: AttachedAgentTarget,
  packet: Record<string, unknown>, dependencies: Partial<Dependencies> = {},
): Promise<AttachedAgentHostResult> {
  if (!ownerId || agent.user_id !== ownerId || agent.id !== target.sourceId || agent.status !== "running"
    || agent.computer_profile !== "ubuntu-desktop" || agent.computer_substrate !== "proxmox-kvm"
    || agent.infrastructure_binding_token_enforced !== true || agent.vmid !== target.vmid || agent.ip !== target.guestIp) {
    return { ok: false, code: "invalid_target" };
  }
  const deps = { resolveContext: resolveHivraAgentExecutionContext, runHostScript: runProxmoxHostScriptWithStdin, ...dependencies };
  let context;
  try { context = await deps.resolveContext(ownerId, agent); } catch { return { ok: false, code: "authority_unavailable" }; }
  if (!context.infrastructureBindingTagEnforced || context.infrastructureBindingTag !== target.bindingTag) {
    return { ok: false, code: "authority_unavailable" };
  }
  let step: { script: string; stdin: string };
  try { step = buildAttachedAgentHostScript(action, target, packet); } catch { return { ok: false, code: "invalid_target" }; }
  try {
    const result = await deps.runHostScript(step.script, step.stdin, { ...context.env },
      { timeoutMs: ATTACHED_AGENT_TIMEOUTS[action].hostMs, maxOutputBytes: 64 * 1024 });
    if (!result.ok) {
      const refused = parseAttachmentTargetRefusal(result.stdout);
      if (refused) return { ok: false, code: "target_refused", reason: refused };
      const named = parseGuestStepRefusal(result.stdout, ATTACHED_AGENT_REFUSALS);
      if (named) return { ok: false, code: "guest_refused", reason: named };
      logAttachmentTransportFailure(action, { sourceId: target.sourceId, vmid: target.vmid }, result);
      return { ok: false, code: "transport_failed" };
    }
    const parsed = parseAttachedAgentResult(action, result.stdout);
    return parsed ? { ok: true, result: parsed } : { ok: false, code: "invalid_result" };
  } catch (error) {
    logAttachmentTransportFailure(action, { sourceId: target.sourceId, vmid: target.vmid }, error);
    return { ok: false, code: "transport_failed" };
  }
}
