import "server-only";

// What Hivra does when a host's wake proxy calls it (the request is already
// verified, see host-credential.ts):
//
//   wake-report   {vmid, woke: "nap", at, from}
//     The proxy resumed a napping computer itself. Set the record awake now
//     (instead of at the next sweep) and take every channel's wake arm down,
//     so a Telegram webhook armed for the nap is removed at once.
//   wake-request  {vmid, reason: "ticket" | "client" | "doorbell" | "ctl"}
//     The host wants a computer awake that it cannot resume itself (a
//     hibernated one), or whose wake needs the server (a channel arm to take
//     down). Starts the normal wake in the background and answers at once.
//
// A host may only name its own computers: the agent is found by vmid among
// the running agents placed on the calling host. Both only ever move an agent
// toward awake.

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveHivraProxmoxHost } from "@/lib/hivra/proxmox-target";
import {
  isAgentAwake,
  logAgentSleepEvent,
  parseSleepGeneration,
  reconcileAgentSleepState,
  type AgentSleepEventTrigger,
} from "@/lib/hivra/agent-sleep-store";
import { ensureHivraAgentAwake, type AgentRow, type EnsureAwakeResult } from "@/lib/hivra/agent-wake";
import { disarmChannelsForWake, settleChannelsAfterWake, type ChannelDisarms } from "@/lib/hivra/channel-wake/lifecycle";

const LOG_SOURCE = "ingress-host-calls";

export const WAKE_REQUEST_REASONS = ["ticket", "client", "doorbell", "ctl"] as const;
export type WakeRequestReason = (typeof WAKE_REQUEST_REASONS)[number];

export interface HostCallDeps {
  findAgent: (hostId: string, vmid: number) => Promise<AgentRow[]>;
  reconcileAwake: (agentId: string, expectedGeneration: number) => Promise<boolean>;
  logEvent: typeof logAgentSleepEvent;
  disarm: (agentId: string) => Promise<ChannelDisarms>;
  settle: (agentId: string, disarms: ChannelDisarms | null) => Promise<void>;
  ensureAwake: (agentId: string, trigger: AgentSleepEventTrigger) => Promise<EnsureAwakeResult>;
  nowMs: () => number;
}

export interface HostCallAnswer {
  status: 200 | 400 | 404 | 409 | 503;
  body: Record<string, unknown>;
}

async function findAgentOnHost(hostId: string, vmid: number): Promise<AgentRow[]> {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select("*")
    .eq("vmid", vmid)
    .eq("status", "running")
    .limit(10);
  if (error) throw new Error("agent_read_failed");
  return ((data ?? []) as AgentRow[]).filter(
    (row) => resolveHivraProxmoxHost(typeof row.proxmox_host === "string" ? row.proxmox_host : null) === hostId,
  );
}

function defaultDeps(onBackground?: (work: Promise<unknown>) => void): HostCallDeps {
  return {
    findAgent: findAgentOnHost,
    reconcileAwake: (agentId, expectedGeneration) => reconcileAgentSleepState({ agentId, expectedGeneration, to: "awake" }),
    logEvent: logAgentSleepEvent,
    disarm: (agentId) => disarmChannelsForWake(agentId),
    settle: settleChannelsAfterWake,
    ensureAwake: (agentId, trigger) => ensureHivraAgentAwake(agentId, { trigger, waitMs: 0, ...(onBackground ? { onBackground } : {}) }),
    nowMs: Date.now,
  };
}

function vmidOf(body: Record<string, unknown>): number | null {
  const vmid = body.vmid;
  return Number.isSafeInteger(vmid) && (vmid as number) >= 100 && (vmid as number) <= 999_999_999 ? (vmid as number) : null;
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** The one running agent on this host with this vmid, or an answer saying why not. */
async function resolveAgent(
  hostId: string,
  body: Record<string, unknown> | null,
  deps: HostCallDeps,
): Promise<{ agent: AgentRow; vmid: number } | HostCallAnswer> {
  const vmid = body ? vmidOf(body) : null;
  if (vmid === null) return { status: 400, body: { ok: false, error: "bad_request" } };
  let rows: AgentRow[];
  try {
    rows = await deps.findAgent(hostId, vmid);
  } catch {
    return { status: 503, body: { ok: false, error: "unavailable" } };
  }
  if (rows.length === 0) return { status: 404, body: { ok: false, error: "unknown_vmid" } };
  if (rows.length > 1) return { status: 409, body: { ok: false, error: "ambiguous_vmid" } };
  return { agent: rows[0], vmid };
}

/** wake-report: the proxy resumed a napping computer. */
export async function handleWakeReport(
  hostId: string,
  rawBody: unknown,
  overrides: Partial<HostCallDeps> = {},
): Promise<HostCallAnswer> {
  const deps = { ...defaultDeps(), ...overrides };
  const body = asObject(rawBody);
  if (body && body.woke !== "nap") return { status: 400, body: { ok: false, error: "bad_request" } };
  const found = await resolveAgent(hostId, body, deps);
  if ("status" in found) return found;
  const { agent, vmid } = found;
  const agentId = String(agent.id);
  if (isAgentAwake(agent)) return { status: 200, body: { ok: true, vmid, action: "already_awake" } };
  // Only a nap can be resumed by the proxy. A record under a lease is being moved by its own operation.
  if (agent.sleep_state !== "napping") return { status: 200, body: { ok: true, vmid, action: "ignored" } };
  if (agent.operation_id) return { status: 200, body: { ok: true, vmid, action: "busy" } };
  const generation = parseSleepGeneration(agent.sleep_generation);
  if (generation === null) return { status: 200, body: { ok: true, vmid, action: "ignored" } };

  const startedMs = deps.nowMs();
  if (!(await deps.reconcileAwake(agentId, generation))) {
    return { status: 200, body: { ok: true, vmid, action: "raced" } };
  }
  // It runs again: take every channel's wake arm down, each time-boxed, as every other wake does.
  let disarms: ChannelDisarms | null = null;
  try {
    disarms = await deps.disarm(agentId);
  } catch {
    // The channel sweep cleans up an arm left on an awake agent.
  }
  const from = typeof body?.from === "string" && /^[a-z_]{1,16}$/.test(body.from) ? body.from : "unknown";
  const atMs = typeof body?.at === "number" && Number.isFinite(body.at) ? Math.round(body.at * 1000) : null;
  await deps.logEvent({
    agentId,
    kind: "wake",
    trigger: "ingress",
    fromState: "napping",
    toState: "awake",
    generation: generation + 1,
    reason: "proxy_report",
    detail: {
      proxy_from: from,
      ...(atMs !== null ? { lag_ms: Math.max(0, startedMs - atMs) } : {}),
      ...(disarms?.telegram ? { tg_disarm_ok: disarms.telegram.ok, tg_disarm_ms: disarms.telegram.ms } : {}),
      ...(disarms && disarms.generic.length > 0 ? { ch_disarm_ok: disarms.generic.every((d) => d.ok), ch_disarm_ms: disarms.ms } : {}),
    },
  });
  try {
    await deps.settle(agentId, disarms);
  } catch {
    // Settling only tidies the rows; the channel sweep finishes it.
  }
  return { status: 200, body: { ok: true, vmid, action: "reconciled", disarm_ms: disarms?.ms ?? null } };
}

/** wake-request: the host asks for a computer to be woken by the normal wake. */
export async function handleWakeRequest(
  hostId: string,
  rawBody: unknown,
  options: { onBackground?: (work: Promise<unknown>) => void; deps?: Partial<HostCallDeps> } = {},
): Promise<HostCallAnswer> {
  const deps = { ...defaultDeps(options.onBackground), ...options.deps };
  const body = asObject(rawBody);
  const reason = body?.reason;
  if (body && !(WAKE_REQUEST_REASONS as readonly unknown[]).includes(reason)) {
    return { status: 400, body: { ok: false, error: "bad_request" } };
  }
  const found = await resolveAgent(hostId, body, deps);
  if ("status" in found) return found;
  const { agent, vmid } = found;
  const agentId = String(agent.id);
  if (isAgentAwake(agent)) return { status: 200, body: { ok: true, vmid, state: "awake" } };
  // A doorbell is a channel message; everything else is a request to the computer's address.
  const trigger: AgentSleepEventTrigger = reason === "doorbell" ? "channel" : "ingress";
  let result: EnsureAwakeResult;
  try {
    result = await deps.ensureAwake(agentId, trigger);
  } catch (error) {
    log.warn("host wake request could not start a wake", {
      source: LOG_SOURCE,
      failureType: "ingress_wake_request_failed",
      instanceId: agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 503, body: { ok: false, vmid, error: "wake_unavailable" } };
  }
  if (result.state === "failed") {
    return { status: 200, body: { ok: false, vmid, state: "failed", error: result.reason ?? "wake_failed" } };
  }
  return { status: 200, body: { ok: true, vmid, state: result.state } };
}
