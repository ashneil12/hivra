"use client";

// Client for the Hivra agents API (server-backed; replaces the localStorage
// store). Agents are real rows in hivra_agents, provisioned through the
// Proxmox allocator.

import type { AgentId } from "./agent-catalog";
import type { ComputerTemplateId } from "./computer-catalog";
import { AGENT_SLOTS } from "@/lib/subscription/agent-slots";
import { isHiddenWelcomeTitle } from "@/lib/hivra/agent-welcome";
import type { AgentDeploymentDestination } from "@/lib/hivra/agent-placement";
import type { HivraAgentActivity } from "./agent-authority";
import type { ProviderAgentReadinessStage } from "./provider-readiness-contract";
import type { ProviderAgentPowerStage } from "./provider-power-contract";
import {
  PROVIDER_RESIZE_BILLING_CONFIRMATION,
  ProviderResizeCatalogSchema,
  ProviderResizeOperationViewSchema,
  ProviderResizeQuoteSchema,
  type ProviderResizeCatalog,
  type ProviderResizeOperationView,
  type ProviderResizeQuote,
  type ProviderResizeStage,
} from "./provider-agent-resize-contract";
import { z } from "zod";

export type AgentStatus = "provisioning" | "running" | "stopped" | "error" | "deleted";

export interface HivraAgent {
  id: string;
  type: AgentId;
  /** Operating-system image/profile. Separate from the optional agent runtime. */
  computer_profile?: ComputerTemplateId | "linux-terminal" | null;
  name: string;
  status: AgentStatus;
  /** Display-only current activity; never grants authority to retry an operation. */
  activity?: HivraAgentActivity | null;
  /** Provider authority for this box. Surface authentication is negotiated
   * separately from the running gateway's public capability metadata. */
  deployment_mode?: "hivra-managed" | "self-managed";
  computer_substrate?: "proxmox-kvm" | "provider-vm" | "gvisor" | "do-managed-session";
  /** Last observed provider-readiness stage, not a percentage or launch grant. */
  readiness_stage?: ProviderAgentReadinessStage;
  power_stage?: ProviderAgentPowerStage;
  resize_stage?: ProviderResizeStage | "verification_unavailable";
  cpu: number;
  ram: number;
  cpu_max?: number | null;
  ram_max?: number | null;
  vmid?: number | null;
  proxmox_host?: string | null;
  ip?: string | null;
  chat_url?: string | null;
  error?: string | null;
  created_at?: string;
  /** First successful user message observed for this box (write-once server stamp). */
  first_usage_at?: string | null;
  /** Set when the box first reached "running" — drives the "updating" vs "provisioning" distinction. */
  provisioned_at?: string | null;
  /** Bearer token for the box's introspection endpoints (sessions/files/skills). */
  api_token?: string | null;
  /** Onboarding + identity (the bootstrap system). All optional. */
  goal?: string | null;
  context?: string | null;
  personality?: string | null;
  emoji?: string | null;
  /** The concrete first task the user captured at launch. When present, the
   *  agent's first turn performs it and returns the result ("do, don't show"). */
  first_task?: string | null;
  /** Set once the box's SOUL.md/USER.md/first-conversation prompt are seeded. */
  bootstrapped_at?: string | null;
  /** User opted at launch to bill this agent's LLM usage to their managed
   *  Venice wallet — the connect step defaults its wiring toggle from this.
   *  (Aeon's managed-credits opt-in; orthogonal to llm_config below.) */
  managed_venice?: boolean | null;
  /** Key-free alternative-LLM provider summary (null = native vendor auth).
   *  Drives box-side inference routing for codex (and claude-code post-shim). */
  llm_config?: AgentLlmSummary | null;
}

export interface HivraAgentSnapshot {
  id: string;
  status: "creating" | "ready" | "restoring" | "failed";
  retentionPolicy: "until_agent_delete";
  createdAt: string;
  readyAt: string | null;
  lastRestoredAt: string | null;
  restoreCount: number;
  error: string | null;
}

/** Key-free summary of an agent's alternative-LLM config (server-sanitized). */
interface AgentLlmSummary {
  provider: "venice";
  mode: "byok" | "managed";
  model: string | null;
  keyPrefix: string | null;
  walletType: "hermesos" | "card" | null;
  enabledAt: string;
}

/** Launch / post-launch LLM provider selection. */
export interface AgentLlmInput {
  provider: "venice";
  mode: "byok" | "managed";
  /** BYOK only. */
  apiKey?: string;
  /** BYOK only: a Venice key saved in the owner's Vault, read by the server
   * instead of being sent again. Never combined with apiKey. */
  vaultKeyId?: string;
  model?: string;
  /** Managed only. */
  walletType?: "hermesos" | "card";
}

async function readJson(r: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface CreateAgentInput {
  type: AgentId;
  computerProfile?: ComputerTemplateId | "linux-terminal";
  name: string;
  cpu: number;
  ram: number;
  maximumCpu?: number;
  maximumRam?: number;
  browser?: boolean;
  /** Onboarding (the bootstrap system) — what the agent is for + how it shows up. */
  goal?: string;
  context?: string;
  personality?: string;
  emoji?: string;
  /** Deploy-card opt-in: bill this agent's LLM usage to the managed Venice
   *  wallet. Only honored server-side for catalog types with managedVenice. */
  managedVenice?: boolean;
  /** Optional alternative LLM provider (Venice byok/managed) — box-side
   *  inference routing for codex (and claude-code post-shim). */
  llm?: AgentLlmInput;
  /** Explicit placement authority. The server rejects an omitted destination;
   * callers must never infer or silently fall back to managed hosting. */
  deployment: AgentDeploymentDestination;
  /** Stable owner-generated receipt key for native Codex and Ubuntu launches.
   * Reuse this exact UUID after an uncertain response; never mint one per retry. */
  launchRequestId?: string;
  /** A saved template to start from (id or slug). The server checks the owner
   * may use it and applies its identity and skills; fields sent here win. */
  templateId?: string;
}

export class HivraLaunchInProgressError extends Error {
  constructor(readonly launchRequestId: string, message?: string) {
    super(message || "The original launch is still in progress. Check that launch instead of starting another computer.");
    this.name = "HivraLaunchInProgressError";
  }
}

export class HivraLaunchRejectedError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) {
    super(message);
    this.name = "HivraLaunchRejectedError";
  }
}

/** A definite pre-receipt rejection that the user can correct without treating
 * the stable request identity as a terminal journal entry. */
export class HivraLaunchCorrectableError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null,
    readonly computerId: string | null = null) {
    super(message);
    this.name = "HivraLaunchCorrectableError";
  }
}

export type HivraLaunchReceipt =
  | { state: "accepted"; phase: string; agent: HivraAgent }
  | { state: "reconciling"; phase: string };

/** Read the owner-bound receipt without submitting another launch. A missing
 * row is deliberately distinct from a failed launch: the original POST may
 * still be reaching the server. */
export async function findHivraLaunchReceipt(launchRequestId: string): Promise<HivraLaunchReceipt | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  let r: Response;
  try {
    r = await fetch(`/api/hivra/agent-launches/${encodeURIComponent(launchRequestId)}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }
  if (r.status === 404) return null;
  const j = await readJson(r);
  const data = j?.data as {
    launchRequestId?: unknown;
    phase?: unknown;
    agent?: HivraAgent;
    launch?: { state?: unknown; phase?: unknown };
  } | undefined;
  if (!r.ok || !j || j.success !== true) {
    const launch = j?.launch as { state?: unknown } | undefined;
    if (launch?.state === "failed") {
      throw new HivraLaunchRejectedError(
        typeof j?.error === "string" ? j.error : "The saved launch stopped before a computer was accepted.",
        r.status,
        typeof j?.code === "string" ? j.code : null,
      );
    }
    throw new Error("The saved launch receipt could not be checked.");
  }
  if (data?.launchRequestId !== launchRequestId || typeof data.phase !== "string") {
    throw new Error("The saved launch receipt was invalid.");
  }
  if (data.agent && typeof data.agent.id === "string" && typeof data.agent.name === "string") {
    return { state: "accepted", phase: data.phase, agent: data.agent };
  }
  if (r.status === 202 && data.launch?.state === "reconciling") {
    return { state: "reconciling", phase: data.phase };
  }
  throw new Error("The saved launch receipt was invalid.");
}

export async function createAgent(input: CreateAgentInput): Promise<HivraAgent> {
  const r = await fetch("/api/hivra/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const j = await readJson(r);
  if (!r.ok || !j || j.success !== true) {
    const launch = j?.launch as { state?: unknown } | undefined;
    const requestId = typeof j?.launchRequestId === "string" ? j.launchRequestId : input.launchRequestId;
    const message = (j?.error as string) || `Provision failed (${r.status})`;
    if ((launch?.state === "reconciling" || launch?.state === "in_progress" || j?.code === "launch_unconfirmed") && requestId) {
      throw new HivraLaunchInProgressError(requestId, message);
    }
    if (launch?.state === "failed" || j?.code === "request_conflict") {
      throw new HivraLaunchRejectedError(
        message,
        r.status,
        typeof j?.code === "string" ? j.code : null,
      );
    }
    if (r.status >= 400 && r.status < 500) {
      throw new HivraLaunchCorrectableError(
        message,
        r.status,
        typeof j?.code === "string" ? j.code : null,
        typeof j?.computerId === "string" ? j.computerId : null,
      );
    }
    throw new Error(message);
  }
  const data = j.data as {
    agent?: HivraAgent;
    launchRequestId?: unknown;
    launch?: { state?: unknown };
  } | undefined;
  if (
    r.status === 202 &&
    (data?.launch?.state === "in_progress" || data?.launch?.state === "reconciling") &&
    typeof data.launchRequestId === "string" &&
    (!input.launchRequestId || data.launchRequestId === input.launchRequestId)
  ) {
    throw new HivraLaunchInProgressError(data.launchRequestId);
  }
  if (input.launchRequestId) {
    if (
      data?.agent
      && data.launchRequestId === input.launchRequestId
      // A launch with a model key answers from its own admission record,
      // which names the request but has no launch-operation state.
      && (data.launch?.state === "accepted" || (input.llm !== undefined && data.launch === undefined))
    ) return data.agent;
    throw new Error(`Provision returned an invalid receipt (${r.status})`);
  }
  if (data?.agent) return data.agent;
  throw new Error(`Provision returned an invalid response (${r.status})`);
}

export async function listAgents(): Promise<HivraAgent[]> {
  return (await listAgentsResult()).agents;
}

// Error-aware variant: callers that need to distinguish "no agents" from "the
// request failed" (so they can show a retry instead of the deploy CTA) use this.
export async function listAgentsResult(): Promise<{ agents: HivraAgent[]; error: string | null }> {
  try {
    const r = await fetch("/api/hivra/agents", { cache: "no-store" });
    const j = await readJson(r);
    if (!r.ok || !j || j.success !== true) {
      return { agents: [], error: (j?.error as string) || `Couldn't load your agents (${r.status})` };
    }
    return { agents: ((j.data as { agents: HivraAgent[] }).agents) || [], error: null };
  } catch (e) {
    return { agents: [], error: (e as Error).message || "Network error reaching the agents API" };
  }
}

export async function stampAgentFirstUsage(id: string): Promise<void> {
  await fetch(`/api/hivra/agents/${encodeURIComponent(id)}/first-usage`, {
    method: "POST",
    cache: "no-store",
  }).catch(() => {});
}

export async function getAgent(id: string): Promise<HivraAgent | null> {
  const r = await fetch(`/api/hivra/agents/${id}`, { cache: "no-store" });
  const j = await readJson(r);
  if (!r.ok || !j || j.success !== true) return null;
  return (j.data as { agent: HivraAgent }).agent;
}

export async function deleteAgent(id: string, options: {
  signal?: AbortSignal; onProgress?: (message: string) => void;
} = {}): Promise<void> {
  const stages: Record<string, string> = {
    installer_stopping: "Stopping the original installer before removal…",
    operation_finishing: "Waiting for the current computer operation to finish…",
    provider_cleanup: "Removing the computer and verifying its original cloud resources…",
    access_cleanup: "Verifying that computer access has been revoked…",
  };
  const deadline = Date.now() + 10 * 60_000;
  for (let step = 0; step < 80 && Date.now() < deadline; step++) {
    if (options.signal?.aborted) throw new Error("Removal checks stopped. Completed changes are not undone; refresh the original computer before resuming.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, Math.min(110_000, deadline - Date.now()));
    let r: Response, j: Record<string, unknown> | null;
    try {
      r = await fetch(`/api/hivra/agents/${encodeURIComponent(id)}`, { method: "DELETE", signal: controller.signal, redirect: "error" });
      j = await readJson(r);
    } catch {
      // An uncertain delivery stops the loop. No inferred failure, completed
      // deletion or blind destructive retry follows a lost response.
      throw new Error("Couldn't confirm agent deletion. Refresh the agent to check its status before trying again.");
    } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); }
    if (!r.ok || !j || j.success !== true) {
      const message = typeof j?.error === "string" ? j.error.trim() : "";
      throw new Error(message || `Couldn't delete the agent (${r.status})`);
    }
    const data = j.data as Record<string, unknown> | null;
    if (r.status === 200 && data?.ok === true) return;
    // Only the exact same computer's explicit continuation protocol can
    // advance another step. A generic success or 202 is never completion.
    if (r.status !== 202 || !data || data.ok !== false || data.pending !== true || data.agentId !== id
      || typeof data.stage !== "string" || !Object.hasOwn(stages, data.stage)) {
      throw new Error(`Couldn't delete the agent (${r.status})`);
    }
    options.onProgress?.(stages[data.stage]);
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, 5_000);
      options.signal?.addEventListener("abort", finish, { once: true });
      if (options.signal?.aborted) finish();
    });
  }
  throw new Error("Removal has not completed within this check window. The original operation is saved; refresh this computer before resuming. Cloud billing may continue.");
}

export interface PlanInfo {
  subscribed: boolean;
  name: string;
  key: string;
  maxAgents: number;
  maxCpuPerAgent: number;
  maxRamPerAgent: number;
  /** The shared compute POOL (total across all this user's agents), in CPU / GB. */
  poolCpu: number;
  poolRam: number;
  /** Account-wide managed usage from billing, including Hermes. RAM is GB here. */
  usage?: { agentCount: number; usedCpu: number; usedRam: number };
  /** Billing reports no plan at all yet: a new account before the Free plan
   * is turned on. Hivra Cloud launches need a plan first. */
  needsActivation?: boolean;
  /** Billing reports no active plan because this paid one holds the account
   * without granting anything: a payment didn't go through, or it has no
   * agent slots. Free can't be turned on over it; it is settled in Billing.
   * The plan itself stays Free's shape, so nothing reads it as paid. Never
   * set together with `needsActivation`. */
  onHold?: PlanOnHold;
}

export type PlanOnHold = {
  key: string;
  name: string;
  reason: "payment_overdue" | "no_slots";
  /** The billing portal can settle it (a live Stripe subscription bills it). */
  billingPortal: boolean;
};

const FREE_PLAN: PlanInfo = { subscribed: false, name: "Free", key: "free", maxAgents: 1, maxCpuPerAgent: 0.5, maxRamPerAgent: 1, poolCpu: 0.5, poolRam: 1 };

/**
 * True only when `plan` is loaded AND resolves to the FREE tier. Mirrors the
 * repo-wide free-check idiom (`!plan?.subscribed || plan.key === 'free'`) used by
 * OnboardingChecklist and the agent-console paywall, but treats a `null`/undefined
 * plan (still loading) as NOT free so an upgrade pitch never flashes before the
 * user's real plan resolves. Used to fail-closed on the "never pitch a paying
 * customer" rule for the free→paid upgrade prompts.
 *
 * Note: `fetchPlan()` itself falls back to FREE_PLAN on a fetch error, so a paid
 * user hitting a transient /api/billing/usage failure could momentarily read as
 * free here — this is the same fail-to-free behaviour the rest of the dashboard
 * already relies on (feature-lock gating included), and the pitch is non-
 * destructive. The primary "never to paid" guarantee for the sleep prompt is
 * structural: paid tiers are exempt from the inactivity sweep, so they never
 * reach the paused_reason='inactivity' state that surfaces it.
 */
export function isFreePlanInfo(plan: PlanInfo | null | undefined): boolean {
  return !!plan && (!plan.subscribed || plan.key === "free");
}

/** Usage billing observed, with RAM converted from MB to GB; undefined when
 * it is missing or malformed. */
function observedUsage(value: unknown): PlanInfo["usage"] {
  if (!value || typeof value !== "object") return undefined;
  const observed = value as { agentCount?: unknown; usedCpu?: unknown; usedRam?: unknown };
  return typeof observed.agentCount === "number" && Number.isInteger(observed.agentCount) && observed.agentCount >= 0 &&
    typeof observed.usedCpu === "number" && Number.isFinite(observed.usedCpu) && observed.usedCpu >= 0 &&
    typeof observed.usedRam === "number" && Number.isFinite(observed.usedRam) && observed.usedRam >= 0
    ? { agentCount: observed.agentCount, usedCpu: observed.usedCpu, usedRam: observed.usedRam / 1024 }
    : undefined;
}

const PLAN_ON_HOLD_REASONS = new Set(["payment_overdue", "no_slots"]);

/** The paid plan billing says holds an account that has no active plan. */
function planOnHold(value: unknown): PlanOnHold | null {
  if (!value || typeof value !== "object") return null;
  const hold = value as { key?: unknown; name?: unknown; reason?: unknown; billingPortal?: unknown };
  if (typeof hold.key !== "string" || !hold.key.trim() || typeof hold.name !== "string" || !hold.name.trim()) return null;
  if (typeof hold.reason !== "string" || !PLAN_ON_HOLD_REASONS.has(hold.reason)) return null;
  return {
    key: hold.key,
    name: hold.name,
    reason: hold.reason as "payment_overdue" | "no_slots",
    billingPortal: hold.billingPortal === true,
  };
}

// Agent slot counts come from the authoritative source (subscription/agent-slots)
// so the Hermes plans, the Hivra catalog, and this gate can never drift (pre-flight V4).
const HIVRA_MAX_AGENTS: Record<string, number> = {
  free: AGENT_SLOTS.free,
  operator: AGENT_SLOTS.operator,
  fleet: AGENT_SLOTS.fleet,
  command: AGENT_SLOTS.command,
};

// Reads the user's REAL subscription (the same /api/billing/usage the rest of the
// dashboard uses) so Hivra gates launches on their actual plan, not a demo control.
// `subscribed` here means PAID (the auto-created free row is subscribed:true at the
// API but must not unlock paid agents). Plan RAM is in MB → converted to GB; CPU/RAM
// are capped to the Hivra box selectors (8 CPU / 16 GB).
//
// Strict variant for the free→paid pitch surfaces: resolves null when the plan
// is UNKNOWN (request failed / bad payload) instead of defaulting to Free, so
// isFreePlanInfo(null) stays false and a paying customer with one failed
// billing round-trip is never shown an upgrade pitch. Feature-lock callers use
// fetchPlan below, which keeps the house fail-to-Free (a billing outage must
// lock paid features, not unlock them).
export async function fetchPlanStrict(): Promise<PlanInfo | null> {
  try {
    const r = await fetch("/api/billing/usage", { cache: "no-store" });
    const j = await readJson(r);
    if (!r.ok || !j || j.success !== true) return null;
    const d = j.data as {
      subscribed?: boolean;
      usage?: unknown;
      managedUsage?: unknown;
      planOnHold?: unknown;
      plan?: { name?: string; key?: string; maxAgents?: number; maxCpuPerAgent?: number; maxRamPerAgent?: number; totalCpu?: number; totalRam?: number } | null;
    };
    if (!d.subscribed) {
      // No plan. What the account already runs on Hivra Cloud is reported
      // separately (it counts against Free once Free is on); left out when
      // billing couldn't read it, so it stays unknown rather than zero.
      const running = observedUsage(d.managedUsage);
      const runningFields = running ? { usage: running } : {};
      const onHold = planOnHold(d.planOnHold);
      // A paid plan holds the account, and is settled in Billing. Everything
      // else stays Free's, so no caller reads the account as paid or plans
      // beyond what it could get without that plan.
      if (onHold) return { ...FREE_PLAN, ...runningFields, onHold };
      // A new account: Free is what turning a plan on would give.
      return { ...FREE_PLAN, ...runningFields, needsActivation: true };
    }
    // Missing or malformed usage is unknown, not an empty pool. Launch callers
    // require this evidence; plan-only callers keep their existing behavior.
    const usage = observedUsage(d.usage);
    const usageFields = usage ? { usage } : {};
    if (!d.plan) return { ...FREE_PLAN, ...usageFields };
    const key = d.plan.key || "paid";
    if (key === "free") return { ...FREE_PLAN, ...usageFields }; // the free row is subscribed:true but is NOT paid
    const ramGb = Math.max(1, Math.round((Number(d.plan.maxRamPerAgent) || 8192) / 1024)); // plan RAM is MB
    // The POOL is the user's total CPU/RAM budget across all agents (totalCpu/totalRam).
    const poolCpu = Number(d.plan.totalCpu) || Math.min(8, Number(d.plan.maxCpuPerAgent) || 4);
    const poolRam = Math.max(1, Math.round((Number(d.plan.totalRam) || (ramGb * 1024)) / 1024));
    const maxAgents = Number(d.plan.maxAgents);
    return {
      subscribed: true,
      name: d.plan.name || "Plan",
      key,
      maxAgents: Number.isFinite(maxAgents)
        ? maxAgents
        : HIVRA_MAX_AGENTS[key] ?? 1,
      maxCpuPerAgent: Math.min(8, Number(d.plan.maxCpuPerAgent) || 4),
      maxRamPerAgent: Math.min(16, ramGb),
      poolCpu,
      poolRam,
      ...usageFields,
    };
  } catch {
    return null;
  }
}

export async function fetchPlan(): Promise<PlanInfo> {
  return (await fetchPlanStrict()) ?? FREE_PLAN;
}

/** A lifecycle action the server refused or could not verify, with its HTTP status. */
export class AgentActionError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AgentActionError";
    this.status = status;
  }
}

async function agentAction(id: string, action: string, extra?: Record<string, unknown>): Promise<void> {
  const r = await fetch(`/api/hivra/agents/${id}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...(extra || {}) }),
  });
  const j = await readJson(r);
  if (!r.ok || !j || j.success !== true) throw new AgentActionError((j?.error as string) || "Action failed", r.status);
}
export const stopAgent = (id: string) => agentAction(id, "stop");
export const startAgent = (id: string) => agentAction(id, "start");
export const restartAgent = (id: string) => agentAction(id, "restart");
export const updateAgentRuntime = (id: string) => agentAction(id, "update_runtime");
export const resizeAgent = (
  id: string,
  cpu: number,
  ram: number,
  maximumCpu: number,
  maximumRam: number,
) => agentAction(id, "resize", { cpu, ram, maximumCpu, maximumRam });
export const renameAgent = (id: string, name: string) => agentAction(id, "rename", { name });
export const snapshotAgent = (id: string) => agentAction(id, "snapshot");
export const restoreAgentSnapshot = (id: string, snapshotId: string) =>
  agentAction(id, "restore", { snapshotId });

const ProviderResizeViewResponseSchema = z.object({
  operation: ProviderResizeOperationViewSchema.nullable(),
  catalog: ProviderResizeCatalogSchema.nullable(),
}).strict().refine((value) => (value.operation === null) !== (value.catalog === null));

export class ProviderResizeApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "ProviderResizeApiError";
  }
}

async function providerResizeResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await readJson(response);
  if (!response.ok || !body || body.success !== true) {
    throw new ProviderResizeApiError(
      typeof body?.error === "string" ? body.error : "The Hetzner resize could not be confirmed.",
      response.status,
      typeof body?.code === "string" ? body.code : null,
    );
  }
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ProviderResizeApiError("The saved Hetzner resize response was invalid.", 502, "response_invalid");
  }
  return data as Record<string, unknown>;
}

export async function getProviderResizeState(id: string): Promise<{
  operation: ProviderResizeOperationView | null;
  catalog: ProviderResizeCatalog | null;
}> {
  const response = await fetch(`/api/hivra/agents/${encodeURIComponent(id)}/provider-resize`, {
    method: "GET", cache: "no-store", redirect: "error", credentials: "same-origin",
  });
  return ProviderResizeViewResponseSchema.parse(await providerResizeResponse(response));
}

export async function reviewProviderResize(input: {
  agentId: string;
  operationId: string;
  targetServerType: string;
}): Promise<ProviderResizeQuote> {
  const response = await fetch(`/api/hivra/agents/${encodeURIComponent(input.agentId)}/provider-resize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "quote", operationId: input.operationId, targetServerType: input.targetServerType }),
    cache: "no-store", redirect: "error", credentials: "same-origin",
  });
  const data = await providerResizeResponse(response);
  return ProviderResizeQuoteSchema.parse(data.quote);
}

export async function confirmProviderResize(input: {
  agentId: string;
  operationId: string;
  quoteFingerprint: string;
}): Promise<ProviderResizeOperationView> {
  const response = await fetch(`/api/hivra/agents/${encodeURIComponent(input.agentId)}/provider-resize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "apply",
      operationId: input.operationId,
      quoteFingerprint: input.quoteFingerprint,
      billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION,
    }),
    cache: "no-store", redirect: "error", credentials: "same-origin",
  });
  const data = await providerResizeResponse(response);
  return ProviderResizeOperationViewSchema.parse(data.operation);
}

export async function listAgentSnapshots(id: string): Promise<{
  snapshots: HivraAgentSnapshot[];
  supported: boolean;
  maximum: number;
}> {
  const r = await fetch(`/api/hivra/agents/${encodeURIComponent(id)}/snapshots`, {
    cache: "no-store",
  });
  const j = await readJson(r);
  if (!r.ok || !j || j.success !== true) {
    throw new Error((j?.error as string) || "Could not load restore points");
  }
  const data = j.data as {
    snapshots?: HivraAgentSnapshot[];
    supported?: boolean;
    maximum?: number;
  };
  return {
    snapshots: Array.isArray(data.snapshots) ? data.snapshots : [],
    supported: data.supported === true,
    maximum: Number.isInteger(data.maximum) ? Number(data.maximum) : 5,
  };
}

// ---- Box-side Claude login (browser -> box, the user's own native login) ----
function boxBase(boxUrl: string): string {
  return boxUrl.replace(/\/$/, "");
}

export async function boxLoginStatus(boxUrl: string, token?: string | null): Promise<{ loggedIn: boolean; email?: string | null; sub?: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/login/status`, { cache: "no-store", headers: boxHeaders(token) });
    if (!r.ok) return { loggedIn: false };
    return (await r.json()) as { loggedIn: boolean; email?: string; sub?: string };
  } catch {
    return { loggedIn: false };
  }
}

export interface BoxLoginStart {
  url: string;
  /** Codex device-auth: the one-time code the user enters at the URL. */
  code?: string | null;
  /** True for the codex device-auth flow (no code to paste back). */
  deviceAuth?: boolean;
}

export async function boxLoginStartRaw(boxUrl: string, token?: string | null): Promise<BoxLoginStart> {
  const r = await fetch(`${boxBase(boxUrl)}/api/login/start`, { method: "POST", headers: boxHeaders(token) });
  const j = (await r.json().catch(() => ({}))) as { url?: string; code?: string; deviceAuth?: boolean; error?: string };
  if (!r.ok || !j.url) throw new Error(j.error || "Could not start login");
  return { url: j.url, code: j.code || null, deviceAuth: Boolean(j.deviceAuth) };
}

/** Managed-Venice wiring handed to the box at Aeon connect: the box sets these
 *  as secrets/variables on the user's fork so skill runs bill the Hivra wallet.
 *  The box only applies it when the fork's gateway script supports the
 *  VENICE_BASE_URL override (post-sync from upstream) — otherwise it reports
 *  `venice: "unsupported"` and the connect still succeeds. */
export interface BoxVeniceWiring {
  key: string;
  baseUrl: string;
  model?: string;
}

export async function boxLoginComplete(
  boxUrl: string,
  code: string,
  token?: string | null,
  venice?: BoxVeniceWiring | null,
): Promise<{ venice: string | null }> {
  const r = await fetch(`${boxBase(boxUrl)}/api/login/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...boxHeaders(token) },
    body: JSON.stringify(venice ? { code, venice } : { code }),
  });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; venice?: string };
  if (!r.ok || !j.ok) throw new Error(j.error || "Login failed");
  return { venice: j.venice ?? null };
}

// ---- Box introspection: chat-history sessions, file browser, skills ----
// These hit the box's token-gated endpoints (open on legacy/demo boxes). The
// per-box token (when present) is passed as a Bearer header.
function boxHeaders(token?: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface BoxSession { id: string; title: string; updatedAt: number; }
export interface BoxMessage { role: "user" | "assistant"; text: string; tools: string[] }
export interface BoxFileEntry { name: string; type: "dir" | "file"; size: number; mtime: number; }
export interface BoxSkill { id: string; name: string; description: string; }

export async function listBoxSessions(boxUrl: string, token?: string | null): Promise<BoxSession[]> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/sessions`, { cache: "no-store", headers: boxHeaders(token) });
    if (!r.ok) return [];
    const sessions = (((await r.json()) as { sessions?: BoxSession[] }).sessions) || [];
    // The box titles a conversation with its first message, which for the
    // first-contact welcome is the hidden setup prompt. That conversation is the
    // owner's to read and continue, so it lists as "Welcome", and a computer
    // whose only history is its welcome still counts as one with history.
    return sessions.map((s) => (isHiddenWelcomeTitle(s.title) ? { ...s, title: "Welcome" } : s));
  } catch { return []; }
}
export async function readBoxSession(boxUrl: string, id: string, token?: string | null): Promise<BoxMessage[]> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/sessions/${id}`, { cache: "no-store", headers: boxHeaders(token) });
    if (!r.ok) return [];
    return (((await r.json()) as { messages?: BoxMessage[] }).messages) || [];
  } catch { return []; }
}
// ---- Detached chat runs ----
// A chat turn runs on the box independently of the browser request that started
// it, so closing the tab or losing the network does not end the agent's work.
// These let the chat stop a run explicitly and find runs that kept going while
// the page was closed or offline. Boxes on an older runtime have no run API.
export interface BoxChatRun {
  runId: string;
  clientRef: string | null;
  state: "running" | "finished";
  title: string;
  code: number | null;
  stopped: "user" | "disconnect" | null;
  interrupted: boolean;
  agentSessionId: string | null;
  createdAt: string;
  finishedAt: string | null;
}
/** Recent runs, newest first; null when the box predates detached runs, is unreachable, or the signal aborts. */
export async function listBoxChatRuns(boxUrl: string, token?: string | null, signal?: AbortSignal): Promise<BoxChatRun[] | null> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/chat/runs`, { cache: "no-store", headers: boxHeaders(token), signal });
    if (!r.ok) return null;
    const runs = ((await r.json()) as { runs?: BoxChatRun[] }).runs;
    return Array.isArray(runs) ? runs : null;
  } catch { return null; }
}
export function boxChatRunEventsUrl(boxUrl: string, runId: string): string {
  return `${boxBase(boxUrl)}/api/chat/runs/${encodeURIComponent(runId)}/events`;
}
/** Ask the box to end a run. Resolves false when the box could not confirm it. */
export async function stopBoxChatRun(boxUrl: string, runId: string, token?: string | null): Promise<boolean> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/chat/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST", headers: boxHeaders(token), keepalive: true,
    });
    return r.ok;
  } catch { return false; }
}

export async function listBoxFiles(boxUrl: string, dir: string, token?: string | null): Promise<{ path: string; entries: BoxFileEntry[]; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/files?path=${encodeURIComponent(dir)}`, { cache: "no-store", headers: boxHeaders(token) });
    const j = (await r.json().catch(() => ({}))) as { path?: string; entries?: BoxFileEntry[]; error?: string };
    if (!r.ok) return { path: dir, entries: [], error: j.error || `HTTP ${r.status}` };
    return { path: j.path || dir, entries: j.entries || [], error: null };
  } catch (e) { return { path: dir, entries: [], error: (e as Error).message }; }
}
export async function readBoxFile(boxUrl: string, file: string, token?: string | null): Promise<{ content: string; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/file?path=${encodeURIComponent(file)}`, { cache: "no-store", headers: boxHeaders(token) });
    const j = (await r.json().catch(() => ({}))) as { content?: string; error?: string };
    if (!r.ok) return { content: "", error: j.error || `HTTP ${r.status}` };
    return { content: j.content || "", error: null };
  } catch (e) { return { content: "", error: (e as Error).message }; }
}
// Save a text file under the box HOME (the Files tab's edit mode). The box
// requires its API token for writes (legacy token-less boxes are read-only) and
// only allows editing existing, non-credential files up to 512KB.
export async function writeBoxFile(boxUrl: string, file: string, content: string, token?: string | null): Promise<{ ok: boolean; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/file`, { method: "POST", headers: { "Content-Type": "application/json", ...boxHeaders(token) }, body: JSON.stringify({ path: file, content }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
    return { ok: true, error: null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
export async function listBoxSkills(boxUrl: string, token?: string | null): Promise<BoxSkill[]> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/skills`, { cache: "no-store", headers: boxHeaders(token) });
    if (!r.ok) return [];
    return (((await r.json()) as { skills?: BoxSkill[] }).skills) || [];
  } catch { return []; }
}
export async function deleteBoxSkill(boxUrl: string, id: string, token?: string | null): Promise<{ ok: boolean; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/skills/${encodeURIComponent(id)}`, { method: "DELETE", headers: boxHeaders(token) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
    return { ok: true, error: null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ---- Telegram: connect the box's bux Telegram bot to a user's bot token ----
// The box's bux-tg service ships upstream `browser-use/bux`, which supports two
// auth shapes:
//   1. Setup-token deeplink (modern): /etc/bux/tg.env carries TG_SETUP_TOKEN and
//      the first chat to redeem `t.me/<bot>?start=<token>` binds + burns the
//      token (single-use, constant-time compare on the box). The dashboard
//      requests this mode by calling /api/telegram/connect without an ownerId.
//   2. Pre-set owner id (legacy / advanced fallback): /etc/bux/tg.env carries
//      TG_OWNER_ID and the bot auto-binds the owner's first private DM. The
//      dashboard requests this by passing the ownerId.
// Bound the Telegram box round-trips. Without a deadline a blackholed/slow box
// leaves the connect flow's spinner (or the status poll) hanging indefinitely —
// the same silent-hang class fixed on the Hermes lane. AbortSignal.timeout fails
// the fetch with a TimeoutError; connect maps it to a friendly retryable error,
// status/disconnect fall back to their "not connected" defaults.
const TELEGRAM_STATUS_TIMEOUT_MS = 8000;
const TELEGRAM_CONNECT_TIMEOUT_MS = 25000;
const TELEGRAM_SAVE_TIMEOUT_MESSAGE =
  "Saving is taking longer than expected — your bot may still be restarting. Try again in a moment.";

function isTelegramAbortError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

export interface TelegramStatus {
  connected: boolean;
  active: boolean;
  ownerId: string | null;
  /** When set, the box wrote a setup-token to tg.env on connect; the dashboard
   *  surfaces this via the deeplink. The box keeps it ONLY until the first
   *  bind (then `burn_setup_token` wipes it), so subsequent status reads will
   *  return null even on a healthy connected bot. */
  setupToken?: string | null;
  /** The bot's @username (when the server has it), for building deeplinks and
   *  for the "Open in Telegram" button. */
  botUsername?: string | null;
}
export async function telegramStatus(boxUrl: string, token?: string | null): Promise<TelegramStatus> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/telegram/status`, {
      cache: "no-store",
      headers: boxHeaders(token),
      signal: AbortSignal.timeout(TELEGRAM_STATUS_TIMEOUT_MS),
    });
    if (!r.ok) return { connected: false, active: false, ownerId: null };
    return (await r.json()) as TelegramStatus;
  } catch { return { connected: false, active: false, ownerId: null }; }
}
export interface TelegramConnectResult {
  ok: boolean;
  botUsername?: string | null;
  /** Present when the box provisioned the bot in deeplink-pairing mode. */
  setupToken?: string | null;
  error: string | null;
}
/** Connect the bot. Omit `ownerId` for the modern setup-token deeplink flow;
 *  pass it to bypass pairing and pre-bind the user (advanced fallback). */
export async function telegramConnect(
  boxUrl: string,
  botToken: string,
  ownerId: string | null,
  token?: string | null,
): Promise<TelegramConnectResult> {
  try {
    const payload: Record<string, unknown> = { botToken };
    if (ownerId) payload.ownerId = ownerId;
    const r = await fetch(`${boxBase(boxUrl)}/api/telegram/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...boxHeaders(token) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TELEGRAM_CONNECT_TIMEOUT_MS),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; botUsername?: string; setupToken?: string; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
    return { ok: true, botUsername: j.botUsername ?? null, setupToken: j.setupToken ?? null, error: null };
  } catch (e) { return { ok: false, error: isTelegramAbortError(e) ? TELEGRAM_SAVE_TIMEOUT_MESSAGE : (e as Error).message }; }
}
export async function telegramDisconnect(boxUrl: string, token?: string | null): Promise<void> {
  await fetch(`${boxBase(boxUrl)}/api/telegram/disconnect`, {
    method: "POST",
    headers: boxHeaders(token),
    signal: AbortSignal.timeout(TELEGRAM_CONNECT_TIMEOUT_MS),
  }).catch(() => {});
}

// ---- browser automation toggle (Chrome + live-view stack on/off) ----
// `enabled` reflects the box's real runtime state (is the keeper service active).
export async function browserStatus(boxUrl: string, token?: string | null): Promise<{ enabled: boolean; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/browser/status`, { cache: "no-store", headers: boxHeaders(token) });
    const j = (await r.json().catch(() => ({}))) as { enabled?: boolean; error?: string };
    if (!r.ok) return { enabled: false, error: j.error || `HTTP ${r.status}` };
    return { enabled: Boolean(j.enabled), error: null };
  } catch (e) { return { enabled: false, error: (e as Error).message }; }
}
export async function browserToggle(boxUrl: string, enabled: boolean, token?: string | null): Promise<{ ok: boolean; enabled?: boolean; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/browser/toggle`, { method: "POST", headers: { "Content-Type": "application/json", ...boxHeaders(token) }, body: JSON.stringify({ enabled }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; enabled?: boolean; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
    return { ok: true, enabled: j.enabled, error: null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ---- per-box model override (Manage → Model) --------------------------------
// model=null means "the CLI's own default". Changes apply on the NEXT chat turn
// (the box reads ~/.hivra/agent-model per spawn) — no restart, no redeploy.
export async function getBoxModel(boxUrl: string, token?: string | null): Promise<{ model: string | null; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/model`, { cache: "no-store", headers: boxHeaders(token) });
    const j = (await r.json().catch(() => ({}))) as { model?: string | null; error?: string };
    if (!r.ok) return { model: null, error: j.error || `HTTP ${r.status}` };
    return { model: j.model || null, error: null };
  } catch (e) { return { model: null, error: (e as Error).message }; }
}
export async function setBoxModel(boxUrl: string, model: string | null, token?: string | null): Promise<{ ok: boolean; model?: string | null; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/model`, { method: "POST", headers: { "Content-Type": "application/json", ...boxHeaders(token) }, body: JSON.stringify({ model: model || "" }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; model?: string | null; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
    return { ok: true, model: j.model ?? null, error: null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// Manage model-key settings use the server-only delivery flow exposed through
// agent-model-settings-api.ts; no browser-to-guest credential writes.

// ---- permission presets (Manage → Permissions) -------------------------------
// null/"" = full access (the box default). "limited" = no shell (claude) /
// workspace sandbox (codex). "readonly" = deny mutating tools / read-only sandbox.
export type BoxRestrict = "" | "limited" | "readonly";
export async function getBoxRestrict(boxUrl: string, token?: string | null): Promise<{ restrict: BoxRestrict; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/restrict`, { cache: "no-store", headers: boxHeaders(token) });
    const j = (await r.json().catch(() => ({}))) as { restrict?: string | null; error?: string };
    if (!r.ok) return { restrict: "", error: j.error || `HTTP ${r.status}` };
    const v = j.restrict === "limited" || j.restrict === "readonly" ? j.restrict : "";
    return { restrict: v, error: null };
  } catch (e) { return { restrict: "", error: (e as Error).message }; }
}
export async function setBoxRestrict(boxUrl: string, restrict: BoxRestrict, token?: string | null): Promise<{ ok: boolean; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/restrict`, { method: "POST", headers: { "Content-Type": "application/json", ...boxHeaders(token) }, body: JSON.stringify({ restrict }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
    return { ok: true, error: null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ---- git explorer (Git tab) ---------------------------------------------------
export interface GitEntry { x: string; y: string; path: string }
export interface GitStatus { repo: boolean; root?: string; branch?: string | null; branches?: string[]; entries?: GitEntry[]; lastCommit?: string | null; error: string | null }
export async function gitStatus(boxUrl: string, dir: string, token?: string | null): Promise<GitStatus> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/git/status?dir=${encodeURIComponent(dir)}`, { cache: "no-store", headers: boxHeaders(token) });
    const j = (await r.json().catch(() => ({}))) as Omit<GitStatus, "error"> & { error?: string };
    if (!r.ok) return { repo: false, error: j.error || `HTTP ${r.status}` };
    return { ...j, repo: Boolean(j.repo), error: null };
  } catch (e) { return { repo: false, error: (e as Error).message }; }
}
export async function gitDiff(boxUrl: string, dir: string, file: string, token?: string | null): Promise<{ diff: string; untracked: boolean; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/git/diff?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(file)}`, { cache: "no-store", headers: boxHeaders(token) });
    const j = (await r.json().catch(() => ({}))) as { diff?: string; untracked?: boolean; error?: string };
    if (!r.ok) return { diff: "", untracked: false, error: j.error || `HTTP ${r.status}` };
    return { diff: j.diff || "", untracked: Boolean(j.untracked), error: null };
  } catch (e) { return { diff: "", untracked: false, error: (e as Error).message }; }
}
export async function gitCommit(boxUrl: string, dir: string, message: string, paths: string[], token?: string | null): Promise<{ ok: boolean; commit?: string; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/git/commit`, { method: "POST", headers: { "Content-Type": "application/json", ...boxHeaders(token) }, body: JSON.stringify({ dir, message, paths }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; commit?: string; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
    return { ok: true, commit: j.commit, error: null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
export async function gitCheckout(boxUrl: string, dir: string, branch: string, create: boolean, token?: string | null): Promise<{ ok: boolean; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/git/checkout`, { method: "POST", headers: { "Content-Type": "application/json", ...boxHeaders(token) }, body: JSON.stringify({ dir, branch, create }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
    return { ok: true, error: null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ---- uploads (chat attachments) ----------------------------------------------
export async function uploadBoxFile(boxUrl: string, name: string, dataBase64: string, token?: string | null): Promise<{ ok: boolean; path?: string; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/upload`, { method: "POST", headers: { "Content-Type": "application/json", ...boxHeaders(token) }, body: JSON.stringify({ name, dataBase64 }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; path?: string; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
    return { ok: true, path: j.path, error: null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ---- MCP server management (Manage → MCP) --------------------------------------
export interface McpServer { name: string; command: string; args: string[] }
export async function listBoxMcp(boxUrl: string, token?: string | null): Promise<{ servers: McpServer[]; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/mcp`, { cache: "no-store", headers: boxHeaders(token) });
    const j = (await r.json().catch(() => ({}))) as { servers?: McpServer[]; error?: string };
    if (!r.ok) return { servers: [], error: j.error || `HTTP ${r.status}` };
    return { servers: j.servers || [], error: null };
  } catch (e) { return { servers: [], error: (e as Error).message }; }
}
export async function addBoxMcp(boxUrl: string, name: string, command: string, args: string[], token?: string | null): Promise<{ ok: boolean; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...boxHeaders(token) }, body: JSON.stringify({ name, command, args }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
    return { ok: true, error: null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
export async function removeBoxMcp(boxUrl: string, name: string, token?: string | null): Promise<{ ok: boolean; error: string | null }> {
  try {
    const r = await fetch(`${boxBase(boxUrl)}/api/mcp/${encodeURIComponent(name)}`, { method: "DELETE", headers: boxHeaders(token) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
    return { ok: true, error: null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
