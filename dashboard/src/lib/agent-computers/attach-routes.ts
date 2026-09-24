import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { resolvePlanAgentSlots, validateAgentResources } from "@/lib/hivra/resource-gate";
import { ATTACH_INSTALLER_SHA256, ATTACH_NOT_AVAILABLE, attachSupported, type AttachGrants } from "./attach-plan";
import { ATTACH_GRANT_POLICY_SHA256, ATTACHED_SERVICE_POLICY_V2_SHA256, accessReviewSha256, attachReviewSha256,
  removeReviewSha256 } from "./attach-review";
import { createAttachmentLifecycleStore, type AttachmentLifecycleStore, type AttachmentView, type AttachTarget } from "./attachment-lifecycle-store";

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

export type AttachReason = "unsupported_computer" | "agent_present" | "computer_not_running" | "computer_busy" | "plan_agent_limit" | "plan_required";

/** One sentence per refusal; nothing is bought or upgraded automatically. */
export function attachReasonCopy(reason: AttachReason, planMessage?: string): string {
  switch (reason) {
    case "unsupported_computer": return ATTACH_NOT_AVAILABLE;
    case "agent_present": return "Codex is already on this computer.";
    case "computer_not_running": return "Start the computer to add Codex.";
    case "computer_busy": return "This computer is busy with another step. Try again in a minute.";
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
}

export function attachDependencies(overrides: Partial<AttachDependencies> = {}): AttachDependencies {
  return { store: createAttachmentLifecycleStore(), loadComputer: loadOwnedComputer, validate: validateAgentResources,
    planSlots: resolvePlanAgentSlots, ...overrides };
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
  // The plan limit counts only agents on Hivra Cloud; My server uses the owner's own capacity (5.1).
  if (computer.deploymentMode === "hivra-managed") {
    const gate = await deps.validate({ userId: ownerId, type: "codex", cpu: 0, ram: 0, browser: false, mode: "attach", agentLabel: "Codex" });
    if (!gate.ok) return view(gate.status === 403 && /plan access/i.test(gate.message) ? "plan_required" : "plan_agent_limit", target, attachments, gate.message);
  }
  return view(null, target, attachments);
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
  if (!target.eligible) {
    const reason = target.reason ?? "unsupported_computer";
    return { ok: false, status: 409, message: attachReasonCopy(reason), reason };
  }
  let agentLimit = 100000;
  if (computer.deploymentMode === "hivra-managed") {
    const gate = await deps.validate({ userId: ownerId, type: "codex", cpu: 0, ram: 0, browser: false, mode: "attach", agentLabel: "Codex" });
    if (!gate.ok) return { ok: false, status: 403, message: gate.message, reason: "plan_agent_limit" };
    const slots = await deps.planSlots(ownerId);
    if (!slots) return { ok: false, status: 403, message: attachReasonCopy("plan_required"), reason: "plan_required" };
    agentLimit = slots.agentLimit;
  }
  const claim = await deps.store.claim({ ownerId, sourceId: computerId, operationId: input.requestId, authorityCommandId: crypto.randomUUID(),
    authority: target.authority, agentLimit,
    intent: { version: 2, agentIdentityId: crypto.randomUUID(), runtimeId: "codex", agentName: "Codex", installerSha256: ATTACH_INSTALLER_SHA256,
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
