import { ATTACH_UPDATE_RUNTIME_COPY } from "./attach-copy";
import "server-only";

import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { resolvePlanAgentSlots, validateAgentResources } from "@/lib/hivra/resource-gate";
import { ATTACH_INSTALLER_SHA256, ATTACH_NOT_AVAILABLE, attachSupported, type AttachGrants } from "./attach-plan";
import { ATTACH_GRANT_POLICY_SHA256, ATTACHED_SERVICE_POLICY_V2_SHA256, accessReviewSha256, attachReviewSha256,
  removeReviewSha256 } from "./attach-review";
import { createAttachmentLifecycleStore, type AttachmentLifecycleStore, type AttachmentView, type AttachTarget } from "./attachment-lifecycle-store";
import { readAttachedGatewayProtocol } from "./attached-gateway-protocol";

// What the attach routes decide (design 5.6, 5.8): owner from auth only, the
// computer looked up with that owner, the review recomputed here, the plan's
// agent limit checked early for its copy and enforced again by the database,
// and every refusal in the gate's own plain words.

export interface ComputerFacts {
  id: string;
  name: string;
  type: string;
  cpu: number;
  ramGb: number;
  deploymentMode: string | null;
  status: string | null;
  computerProfile: string | null;
  computerSubstrate: string | null;
  bindingEnforced: boolean | null;
  chatUrl: string | null;
}

/** The owner's own computer row, or null: a foreign or missing id is a 404 before any RPC (T1). */
export async function loadOwnedComputer(ownerId: string, computerId: string): Promise<ComputerFacts | null> {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  const { data, error } = await supabaseAdmin.from("hivra_agents")
    .select("id, name, type, cpu, ram, deployment_mode, status, computer_profile, computer_substrate, infrastructure_binding_token_enforced, chat_url")
    .eq("id", computerId).eq("user_id", ownerId).neq("status", "deleted").maybeSingle();
  if (error) throw new Error("database_unavailable");
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return { id: String(row.id), name: String(row.name ?? ""), type: String(row.type ?? ""), cpu: Number(row.cpu) || 0,
    ramGb: Number(row.ram) || 0, deploymentMode: (row.deployment_mode as string | null) ?? null, status: (row.status as string | null) ?? null,
    computerProfile: (row.computer_profile as string | null) ?? null, computerSubstrate: (row.computer_substrate as string | null) ?? null,
    bindingEnforced: (row.infrastructure_binding_token_enforced as boolean | null) ?? null, chatUrl: (row.chat_url as string | null) ?? null };
}

export type AttachReason = "unsupported_computer" | "agent_present" | "computer_not_running" | "computer_not_ready" | "computer_busy"
  | "computer_update_required" | "plan_agent_limit" | "plan_required";

/** Where the owner updates a computer's Hivra service (Manage → Power). */
export { ATTACH_UPDATE_RUNTIME_COPY };

/** One sentence per refusal; nothing is bought or upgraded automatically. */
export function attachReasonCopy(reason: AttachReason, planMessage?: string): string {
  switch (reason) {
    case "unsupported_computer": return ATTACH_NOT_AVAILABLE;
    case "agent_present": return "Codex is already on this computer.";
    case "computer_not_running": return "Start the computer to add Codex.";
    case "computer_not_ready": return "This computer isn't ready yet. Add Codex once it has finished starting.";
    case "computer_busy": return "This computer is busy with another step. Try again in a minute.";
    case "computer_update_required": return ATTACH_UPDATE_RUNTIME_COPY;
    case "plan_required": return "Plan access is required before adding an agent.";
    case "plan_agent_limit": return planMessage ?? "Your plan's agent limit is reached. Upgrade for more slots, or remove an agent first.";
  }
}

export interface AttachGateView {
  computer: { id: string; name: string; cpu: number; ramGb: number; deploymentMode: string | null };
  available: boolean;
  reason: AttachReason | null;
  message: string | null;
  /** Only when the plan's agent limit refuses: a link to Billing, and no Review (5.8). */
  billingHref: string | null;
  reviews: { workspaceOn: string; workspaceOff: string } | null;
  policy: { grantPolicySha256: string; servicePolicySha256: string; installerSha256: string };
  attachments: Array<AttachmentView & {
    chatPath: string | null;
    /** The digests of the two reviews an attached agent offers (5.8). */
    reviews: { accessChange: string; remove: string } | null;
  }>;
}

export interface AttachDependencies {
  store: AttachmentLifecycleStore;
  loadComputer: typeof loadOwnedComputer;
  validate: typeof validateAgentResources;
  planSlots: typeof resolvePlanAgentSlots;
  /** Whether the computer's gateway serves attached agents (release 2026.09.24.3 on). */
  gatewayProtocol: typeof readAttachedGatewayProtocol;
}

export function attachDependencies(overrides: Partial<AttachDependencies> = {}): AttachDependencies {
  return { store: createAttachmentLifecycleStore(), loadComputer: loadOwnedComputer, validate: validateAgentResources,
    planSlots: resolvePlanAgentSlots, gatewayProtocol: readAttachedGatewayProtocol, ...overrides };
}

/** A gateway that answered without attached agents refuses the gate; one that
 * did not answer is left to the claim and to the computer's own check. */
async function gatewayRefusal(chatUrl: string | null | undefined, deps: AttachDependencies): Promise<AttachReason | null> {
  return await deps.gatewayProtocol(chatUrl) === "update_required" ? "computer_update_required" : null;
}

function subject(computer: ComputerFacts) {
  return { sourceId: computer.id, deploymentMode: computer.deploymentMode, cpu: computer.cpu, ramGb: computer.ramGb };
}

/** The gate's facts for one computer, or null when it is not the owner's. */
export async function readAttachGate(ownerId: string, computerId: string, deps: AttachDependencies): Promise<AttachGateView | null> {
  const computer = await deps.loadComputer(ownerId, computerId);
  if (!computer) return null;
  const view = (reason: AttachReason | null, target: AttachTarget | null, attachments: AttachmentView[], planMessage?: string): AttachGateView => ({
    computer: { id: computer.id, name: computer.name, cpu: computer.cpu, ramGb: computer.ramGb, deploymentMode: computer.deploymentMode },
    available: reason === null,
    reason,
    message: reason ? attachReasonCopy(reason, planMessage) : null,
    billingHref: reason === "plan_agent_limit" ? "/dashboard/billing" : null,
    reviews: reason === null && target ? { workspaceOn: attachReviewSha256(subject(computer), { workspace: true }),
      workspaceOff: attachReviewSha256(subject(computer), { workspace: false }) } : null,
    policy: { grantPolicySha256: ATTACH_GRANT_POLICY_SHA256, servicePolicySha256: ATTACHED_SERVICE_POLICY_V2_SHA256,
      installerSha256: ATTACH_INSTALLER_SHA256 },
    attachments: attachments.map((attachment) => ({ ...attachment,
      chatPath: attachment.phase === "attached" && attachment.installationId ? `/agents/${attachment.installationId}` : null,
      reviews: attachment.phase === "attached" && attachment.grants ? {
        accessChange: accessReviewSha256(attachment.id, attachment.grants, { workspace: !attachment.grants.workspace }),
        remove: removeReviewSha256(attachment.id, attachment.grants) } : null })),
  });
  if (!attachSupported({ type: computer.type, computer_profile: computer.computerProfile, computer_substrate: computer.computerSubstrate,
    infrastructure_binding_token_enforced: computer.bindingEnforced, deployment_mode: computer.deploymentMode })) {
    return view("unsupported_computer", null, []);
  }
  const [target, attachments] = await Promise.all([deps.store.readTarget(ownerId, computerId), deps.store.readAttachments(ownerId, computerId)]);
  if (!target) return view("unsupported_computer", null, attachments);
  if (!target.eligible) return view(target.reason ?? "unsupported_computer", target, attachments);
  const gateway = await gatewayRefusal(computer.chatUrl, deps);
  if (gateway) return view(gateway, target, attachments);
  // The plan limit counts only agents on Hivra Cloud; My server uses the owner's own capacity (5.1).
  if (computer.deploymentMode === "hivra-managed") {
    const gate = await deps.validate({ userId: ownerId, type: "codex", cpu: 0, ram: 0, browser: false, mode: "attach", agentLabel: "Codex" });
    if (!gate.ok) return view(gate.status === 403 && /plan access/i.test(gate.message) ? "plan_required" : "plan_agent_limit", target, attachments, gate.message);
  }
  return view(null, target, attachments);
}

/** One supported computer's live answer for Launch's "Put an agent on a
 * computer I already have": null when Add would open the gate, else the gate's
 * own reason and words (5.8). */
export type AttachChoice = { reason: AttachReason | null; message: string | null };
const MAX_CHOICES = 25;

/**
 * The gate's answer for each computer the first pair supports, without the
 * owner's review: running, ready, free, no agent on it, a gateway that serves
 * attached agents, and the plan's agent limit for Hivra Cloud (checked once).
 * The claim checks all of it again.
 */
export async function readAttachChoices(ownerId: string,
  computers: Array<{ id: string; deploymentMode: string | null; chatUrl?: string | null }>,
  deps: AttachDependencies): Promise<Map<string, AttachChoice>> {
  const listed = computers.slice(0, MAX_CHOICES);
  const targets = await Promise.all(listed.map((computer) => deps.store.readTarget(ownerId, computer.id)));
  // Only a computer the gate would otherwise open is asked, all at once.
  const gateways = await Promise.all(listed.map((computer, index) =>
    targets[index]?.eligible ? gatewayRefusal(computer.chatUrl, deps) : Promise.resolve(null)));
  let plan: AttachChoice | null | undefined;
  const choices = new Map<string, AttachChoice>();
  for (const [index, computer] of listed.entries()) {
    const target = targets[index];
    if (!target || !target.eligible) {
      const reason = target?.reason ?? "unsupported_computer";
      choices.set(computer.id, { reason, message: attachReasonCopy(reason) });
      continue;
    }
    const gateway = gateways[index];
    if (gateway) {
      choices.set(computer.id, { reason: gateway, message: attachReasonCopy(gateway) });
      continue;
    }
    if (computer.deploymentMode === "hivra-managed") {
      if (plan === undefined) {
        const gate = await deps.validate({ userId: ownerId, type: "codex", cpu: 0, ram: 0, browser: false, mode: "attach", agentLabel: "Codex" });
        if (gate.ok) plan = null;
        else {
          const reason: AttachReason = gate.status === 403 && /plan access/i.test(gate.message) ? "plan_required" : "plan_agent_limit";
          plan = { reason, message: attachReasonCopy(reason, gate.message) };
        }
      }
      if (plan) { choices.set(computer.id, plan); continue; }
    }
    choices.set(computer.id, { reason: null, message: null });
  }
  return choices;
}

export type AttachMutation =
  | { ok: true; status: 202; operationId: string; resumed: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string; reason?: string };

const CLAIM_REFUSALS: Record<string, { status: 400 | 403 | 404 | 409; reason: AttachReason | "review_changed" | "invalid" }> = {
  invalid_request: { status: 400, reason: "invalid" },
  conflict: { status: 409, reason: "review_changed" },
  not_found: { status: 404, reason: "invalid" },
  review_changed: { status: 409, reason: "review_changed" },
  not_eligible: { status: 409, reason: "unsupported_computer" },
  agent_present: { status: 409, reason: "agent_present" },
  computer_not_running: { status: 409, reason: "computer_not_running" },
  computer_busy: { status: 409, reason: "computer_busy" },
};
const REVIEW_CHANGED = "The review changed. Check it again.";

/**
 * The claim's new agent identity and its authority command, derived from the
 * owner and the review's request id: resending the same review after a lost
 * answer is the same claim, byte for byte, and resumes it (T2).
 */
export function attachClaimIds(ownerId: string, requestId: string): { agentIdentityId: string; authorityCommandId: string } {
  const id = (label: string) => {
    const bytes = createHash("sha256").update(`hivra-attach-${label}\u0000${ownerId}\u0000${requestId}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  return { agentIdentityId: id("identity"), authorityCommandId: id("authority-command") };
}

/** Add: one claim, never a cancel; the minute worker does the rest (5.5). */
export async function claimAttach(ownerId: string, computerId: string, input: { grants: AttachGrants; reviewSha256: string; requestId: string },
  deps: AttachDependencies): Promise<AttachMutation> {
  const computer = await deps.loadComputer(ownerId, computerId);
  if (!computer) return { ok: false, status: 404, message: "Computer not found." };
  if (attachReviewSha256(subject(computer), input.grants) !== input.reviewSha256) {
    return { ok: false, status: 409, message: REVIEW_CHANGED, reason: "review_changed" };
  }
  const target = await deps.store.readTarget(ownerId, computerId);
  if (!target) return { ok: false, status: 404, message: "Computer not found." };
  // The same review sent again after a lost answer: this very claim is the
  // computer's live one. Resume it; the database compares the intent exactly.
  const resuming = target.liveAttachmentId === input.requestId;
  if (!target.eligible && !resuming) {
    const reason = target.reason ?? "unsupported_computer";
    return { ok: false, status: 409, message: attachReasonCopy(reason), reason };
  }
  if (!resuming) {
    const gateway = await gatewayRefusal(computer.chatUrl, deps);
    if (gateway) return { ok: false, status: 409, message: attachReasonCopy(gateway), reason: gateway };
  }
  let agentLimit = 100000;
  if (computer.deploymentMode === "hivra-managed" && !resuming) {
    const gate = await deps.validate({ userId: ownerId, type: "codex", cpu: 0, ram: 0, browser: false, mode: "attach", agentLabel: "Codex" });
    if (!gate.ok) return { ok: false, status: 403, message: gate.message, reason: "plan_agent_limit" };
    const slots = await deps.planSlots(ownerId);
    if (!slots) return { ok: false, status: 403, message: attachReasonCopy("plan_required"), reason: "plan_required" };
    agentLimit = slots.agentLimit;
  }
  const ids = attachClaimIds(ownerId, input.requestId);
  const claim = await deps.store.claim({ ownerId, sourceId: computerId, operationId: input.requestId, authorityCommandId: ids.authorityCommandId,
    authority: target.authority, agentLimit,
    intent: { version: 2, agentIdentityId: ids.agentIdentityId, runtimeId: "codex", agentName: "Codex", installerSha256: ATTACH_INSTALLER_SHA256,
      grants: { workspace: input.grants.workspace }, grantPolicySha256: ATTACH_GRANT_POLICY_SHA256, reviewSha256: input.reviewSha256,
      requestId: input.requestId } });
  if (claim.status === "claimed" && claim.operationId) {
    return { ok: true, status: 202, operationId: claim.operationId, resumed: claim.resumed === true };
  }
  if (claim.status === "plan_agent_limit") {
    const slots = await deps.planSlots(ownerId);
    return { ok: false, status: 403, reason: "plan_agent_limit", message: attachReasonCopy("plan_agent_limit",
      slots ? `Your ${slots.planName} plan allows ${claim.limit} active agent${claim.limit === 1 ? "" : "s"} and you already have ${claim.activeCount}. Upgrade for more slots, or remove an agent first.` : undefined) };
  }
  const refusal = CLAIM_REFUSALS[claim.status] ?? { status: 409 as const, reason: "unsupported_computer" as const };
  const message = refusal.reason === "review_changed" ? REVIEW_CHANGED
    : refusal.reason === "invalid" ? "The request could not be read." : attachReasonCopy(refusal.reason);
  return { ok: false, status: refusal.status, message, reason: refusal.reason };
}

const OPERATION_REFUSALS: Record<string, { status: 400 | 404 | 409; message: string }> = {
  invalid_request: { status: 400, message: "The request could not be read." },
  conflict: { status: 409, message: REVIEW_CHANGED },
  not_found: { status: 404, message: "Codex is not on this computer." },
  not_attached: { status: 409, message: "Codex is not ready on this computer yet." },
  review_changed: { status: 409, message: REVIEW_CHANGED },
  computer_not_running: { status: 409, message: "Start the computer to change what Codex can use or to remove it." },
  computer_busy: { status: 409, message: "This computer is busy with another step. Try again in a minute." },
  unchanged: { status: 409, message: "Codex already has this access." },
};

/** Change access and Remove: each its own reviewed operation (5.5, 5.8). */
export async function beginAttachmentOperation(ownerId: string, computerId: string, attachmentId: string,
  input: { kind: "access_change" | "detach"; grants?: AttachGrants; reviewSha256: string; requestId: string },
  deps: AttachDependencies): Promise<AttachMutation> {
  const computer = await deps.loadComputer(ownerId, computerId);
  if (!computer) return { ok: false, status: 404, message: "Computer not found." };
  const attachments = await deps.store.readAttachments(ownerId, computerId);
  const attachment = attachments.find((item) => item.id === attachmentId);
  if (!attachment) return { ok: false, status: 404, message: "Codex is not on this computer." };
  if (attachment.phase !== "attached" || !attachment.grants) return { ok: false, status: 409, message: "Codex is not ready on this computer yet." };
  const grants = input.kind === "detach" ? attachment.grants : input.grants!;
  const expected = input.kind === "detach" ? removeReviewSha256(attachmentId, attachment.grants)
    : accessReviewSha256(attachmentId, attachment.grants, grants);
  if (expected !== input.reviewSha256) return { ok: false, status: 409, message: REVIEW_CHANGED, reason: "review_changed" };
  const target = await deps.store.readTarget(ownerId, computerId);
  if (!target) return { ok: false, status: 404, message: "Computer not found." };
  const begun = await deps.store.beginOperation({ ownerId, attachmentId, operationId: input.requestId, kind: input.kind,
    authority: target.authority, grants: { workspace: grants.workspace }, reviewSha256: input.reviewSha256 });
  if (begun.status === "claimed" && begun.operationId) return { ok: true, status: 202, operationId: begun.operationId, resumed: begun.resumed === true };
  const refusal = OPERATION_REFUSALS[begun.status] ?? { status: 409 as const, message: "This step could not be started." };
  return { ok: false, status: refusal.status, message: refusal.message, reason: begun.status };
}
