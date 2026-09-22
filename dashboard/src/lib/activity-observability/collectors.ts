import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { mintActivityCollectorToken } from "./auth";
import { NATIVE_TRACING_AGENT_TYPES } from "./types";

// Guest agent-run reporter credentials and per-computer reporter state.
// Contract: docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md

export const ACTIVITY_COLLECTOR_TTL_SECONDS = 7 * 24 * 60 * 60;
export const ACTIVITY_INGEST_PATH = "/api/activity/ingest";
export const ACTIVITY_RENEW_PATH = "/api/activity/collector/renew";

export type ActivityCollectorIssueReason = "launch" | "start" | "renew";

export interface ActivityCollectorCredential {
  endpoint: string;
  resourceId: string;
  token: string;
  expiresAt: string;
}

/** Exact public https origin of this dashboard deployment, or null when it cannot receive guest traffic. */
export function activityControlOrigin(value = process.env.NEXT_PUBLIC_APP_URL): string | null {
  const raw = value?.trim() ?? "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && parsed.origin === raw && !parsed.username && !parsed.password
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

/** Whether this computer has a verified native producer (Claude Code or Codex on Proxmox). */
export function supportsNativeTracing(agent: { type?: string | null; computer_substrate?: string | null }): boolean {
  return !!agent.type && NATIVE_TRACING_AGENT_TYPES.has(agent.type)
    && (agent.computer_substrate ?? "proxmox-kvm") === "proxmox-kvm";
}

/**
 * Mint a 7-day credential scoped to exactly one computer. Returns null (never
 * throws) when this deployment has no public origin or no signing secret, so a
 * missing reporter can never fail a launch or start; Activity then shows the
 * computer as missing coverage.
 */
export function issueActivityCollectorCredential(input: {
  userId: string;
  agentId: string;
  nowSeconds?: number;
  origin?: string | null;
}): ActivityCollectorCredential | null {
  const origin = input.origin === undefined ? activityControlOrigin() : input.origin;
  if (!origin) return null;
  const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + ACTIVITY_COLLECTOR_TTL_SECONDS;
  const resourceId = input.agentId.trim().toLowerCase();
  try {
    const token = mintActivityCollectorToken({ userId: input.userId, resourceIds: [resourceId], iat, exp });
    return { endpoint: `${origin}${ACTIVITY_INGEST_PATH}`, resourceId, token, expiresAt: new Date(exp * 1000).toISOString() };
  } catch {
    return null;
  }
}

/** Record an issuance. Best effort: returns false instead of throwing. */
export async function recordActivityCollectorIssued(
  client: SupabaseClient,
  input: { agentId: string; userId: string; expiresAt: string; reason: ActivityCollectorIssueReason; issuedAt?: Date },
): Promise<boolean> {
  const now = (input.issuedAt ?? new Date()).toISOString();
  try {
    const { error } = await client.from("hivra_activity_collectors").upsert({
      agent_id: input.agentId,
      user_id: input.userId,
      issued_at: now,
      credential_expires_at: input.expiresAt,
      issue_reason: input.reason,
      updated_at: now,
    }, { onConflict: "agent_id" });
    return !error;
  } catch {
    return false;
  }
}

const iso = (value: Date | string): string => (typeof value === "string" ? new Date(value) : value).toISOString();

/**
 * Upsert per-computer reporter state keyed on agent_id, writing only the
 * columns in the row. Best effort: returns false instead of throwing, including
 * when a timestamp input is invalid.
 */
async function upsertCollectorState(client: SupabaseClient, row: () => Record<string, string>): Promise<boolean> {
  try {
    const { error } = await client.from("hivra_activity_collectors").upsert(row(), { onConflict: "agent_id" });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Record that the reporter delivered a heartbeat. `receivedAt` is the
 * dashboard's own receive time (never the guest clock) and
 * `credentialExpiresAt` comes from the token actually in use.
 */
export async function recordCollectorHeartbeat(
  client: SupabaseClient,
  input: { agentId: string; userId: string; receivedAt: Date | string; credentialExpiresAt: string },
): Promise<boolean> {
  return upsertCollectorState(client, () => {
    const at = iso(input.receivedAt);
    return {
      agent_id: input.agentId,
      user_id: input.userId,
      last_heartbeat_at: at,
      credential_expires_at: iso(input.credentialExpiresAt),
      updated_at: at,
    };
  });
}

/** Record that ingest accepted at least one new activity event from this computer. */
export async function recordCollectorEvents(
  client: SupabaseClient,
  input: { agentId: string; userId: string; receivedAt: Date | string; credentialExpiresAt?: string },
): Promise<boolean> {
  return upsertCollectorState(client, () => {
    const at = iso(input.receivedAt);
    return {
      agent_id: input.agentId,
      user_id: input.userId,
      last_event_at: at,
      ...(input.credentialExpiresAt ? { credential_expires_at: iso(input.credentialExpiresAt) } : {}),
      updated_at: at,
    };
  });
}

/** Record that a correctly signed credential for this computer was refused because it expired. */
export async function recordCollectorRejected(
  client: SupabaseClient,
  input: { agentId: string; userId: string; reason: "expired"; rejectedAt?: Date | string },
): Promise<boolean> {
  return upsertCollectorState(client, () => {
    const at = iso(input.rejectedAt ?? new Date());
    return {
      agent_id: input.agentId,
      user_id: input.userId,
      last_rejected_at: at,
      last_rejected_reason: input.reason,
      updated_at: at,
    };
  });
}

export type ActivityCollectorInstallStatus = "installed" | "failed";

const INSTALL_REASON = /^[a-z_]{1,40}$/;

/**
 * Record the outcome of the most recent guest reporter installation, taken
 * from the host's `HIVRA_ACTIVITY_COLLECTOR` marker. An installed result
 * clears any earlier failure reason; a failure must carry a closed-enum reason.
 * Best effort: returns false instead of throwing, and writes nothing for an
 * unknown status, a malformed reason or an invalid timestamp.
 */
export async function recordCollectorInstallResult(
  client: SupabaseClient,
  input: { agentId: string; userId: string; status: ActivityCollectorInstallStatus; reason?: string; at?: Date },
): Promise<boolean> {
  try {
    if (input.status !== "installed" && input.status !== "failed") return false;
    const reason = input.status === "failed" ? input.reason : undefined;
    if (input.status === "failed" && (typeof reason !== "string" || !INSTALL_REASON.test(reason))) return false;
    if (input.status === "installed" && input.reason !== undefined) return false;
    const at = iso(input.at ?? new Date());
    const { error } = await client.from("hivra_activity_collectors").upsert({
      agent_id: input.agentId,
      user_id: input.userId,
      last_install_status: input.status,
      last_install_reason: reason ?? null,
      last_install_at: at,
      updated_at: at,
    }, { onConflict: "agent_id" });
    return !error;
  } catch {
    return false;
  }
}

/** Record a credential re-issued by the renewal endpoint. */
export function recordCollectorRenewed(
  client: SupabaseClient,
  input: { agentId: string; userId: string; expiresAt: string; issuedAt?: Date },
): Promise<boolean> {
  return recordActivityCollectorIssued(client, { ...input, reason: "renew" });
}
