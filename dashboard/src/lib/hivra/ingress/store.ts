import "server-only";

// hivra_agent_ingress reads and writes for the per-agent cutover. Service
// role only. Every write made during an enable or rollback is conditioned on
// the caller's lease, so a run that lost its lease cannot overwrite a newer
// one. No credential is ever written here.

import { supabaseAdmin } from "@/lib/supabase";
import type { AgentIngressMode, AgentIngressPhase } from "@/lib/hivra/ingress/config";

export const INGRESS_LEASE_MS = 10 * 60 * 1000;

export interface AgentIngressRow {
  agent_id: string;
  vmid: number;
  host_id: string;
  mode: AgentIngressMode | string;
  phase: AgentIngressPhase | string;
  metrics_port: number | null;
  generation: number;
  last_error: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  updated_at: string | null;
}

export type IngressPatch = Partial<Pick<AgentIngressRow, "mode" | "phase" | "metrics_port" | "generation" | "last_error" | "vmid" | "host_id">>;

const COLUMNS = "agent_id, vmid, host_id, mode, phase, metrics_port, generation, last_error, lease_id, lease_expires_at, updated_at";

function db() {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  return supabaseAdmin;
}

/** The agent's ingress row, or null when it has none. Throws when it cannot be read. */
export async function readAgentIngressRow(agentId: string): Promise<AgentIngressRow | null> {
  const { data, error } = await db().from("hivra_agent_ingress").select(COLUMNS).eq("agent_id", agentId).maybeSingle();
  if (error) throw new Error("ingress_read_failed");
  return (data as AgentIngressRow | null) ?? null;
}

/** Creates a guest-mode row when there is none. Leaves an existing row alone. */
export async function ensureAgentIngressRow(input: { agentId: string; vmid: number; hostId: string }): Promise<void> {
  const { error } = await db().from("hivra_agent_ingress").upsert(
    { agent_id: input.agentId, vmid: input.vmid, host_id: input.hostId, mode: "guest", phase: "none" },
    { onConflict: "agent_id", ignoreDuplicates: true },
  );
  if (error) throw new Error("ingress_write_failed");
}

/** Takes the lease when it is free or expired. False when another run holds it. */
export async function claimAgentIngressLease(input: { agentId: string; leaseId: string; nowMs?: number }): Promise<boolean> {
  const now = input.nowMs ?? Date.now();
  const { data, error } = await db().from("hivra_agent_ingress")
    .update({
      lease_id: input.leaseId,
      lease_expires_at: new Date(now + INGRESS_LEASE_MS).toISOString(),
      updated_at: new Date(now).toISOString(),
    })
    .eq("agent_id", input.agentId)
    .or(`lease_id.is.null,lease_expires_at.lt.${new Date(now).toISOString()}`)
    .select("agent_id");
  if (error) throw new Error("ingress_lease_failed");
  return Array.isArray(data) && data.length === 1;
}

/** Writes a patch while the lease is still ours. False when it is not. */
export async function updateAgentIngressUnderLease(input: { agentId: string; leaseId: string; patch: IngressPatch }): Promise<boolean> {
  const { data, error } = await db().from("hivra_agent_ingress")
    .update({ ...input.patch, updated_at: new Date().toISOString() })
    .eq("agent_id", input.agentId)
    .eq("lease_id", input.leaseId)
    .select("agent_id");
  if (error) return false;
  return Array.isArray(data) && data.length === 1;
}

/** Gives the lease back (with a last patch). Never throws. */
export async function releaseAgentIngressLease(input: { agentId: string; leaseId: string; patch?: IngressPatch }): Promise<boolean> {
  try {
    const { data, error } = await db().from("hivra_agent_ingress")
      .update({ ...(input.patch ?? {}), lease_id: null, lease_expires_at: null, updated_at: new Date().toISOString() })
      .eq("agent_id", input.agentId)
      .eq("lease_id", input.leaseId)
      .select("agent_id");
    return !error && Array.isArray(data) && data.length === 1;
  } catch {
    return false;
  }
}

/** Metrics ports other agents on this host hold. */
export async function listHostMetricsPorts(hostId: string, exceptAgentId: string): Promise<number[]> {
  const { data, error } = await db().from("hivra_agent_ingress")
    .select("agent_id, metrics_port")
    .eq("host_id", hostId)
    .not("metrics_port", "is", null);
  if (error) throw new Error("ingress_read_failed");
  return ((data ?? []) as Array<{ agent_id: string; metrics_port: number | null }>)
    .filter((row) => row.agent_id !== exceptAgentId && typeof row.metrics_port === "number")
    .map((row) => row.metrics_port as number);
}

/** Removes the agent's row (after its host side is gone). Never throws. */
export async function deleteAgentIngressRow(agentId: string): Promise<boolean> {
  try {
    const { error } = await db().from("hivra_agent_ingress").delete().eq("agent_id", agentId);
    return !error;
  } catch {
    return false;
  }
}

/** Whether an enable or rollback is running for this row now (sleep must not touch the agent then). */
export function ingressLeaseHeld(row: Pick<AgentIngressRow, "lease_id" | "lease_expires_at"> | null | undefined, nowMs = Date.now()): boolean {
  if (!row?.lease_id || !row.lease_expires_at) return false;
  const until = Date.parse(row.lease_expires_at);
  return Number.isFinite(until) && until > nowMs;
}
