import "server-only";

// The server's side of host ingress for sleep and wake:
//   - loadAgentIngressState: what the agent's ingress row and host switches
//     mean for one sleep or wake (is the host serving it, may ingress code act
//     on it, must it be kept awake).
//   - mintIngressTicket / wakeViaIngress: the ticket fast path. One POST to
//     https://<hostname>/__hivra/wake through the edge and the host connector
//     to the wake proxy, which resumes a napped VM and answers only once the
//     guest's own /healthz says ok.
//
// Fail toward awake. A missing secret, an unreadable row, a refused or slow
// ticket all fall back to the SSH wake, and nothing here ever puts an agent to
// sleep. The ticket is short-lived and single-use, and it is never logged.

import { createHmac, randomBytes } from "node:crypto";

import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { supabaseAdmin } from "@/lib/supabase";
import {
  ingressActsFor,
  ingressNeedsAwake,
  parseAgentIngressMode,
  type IngressHostRow,
} from "@/lib/hivra/ingress/config";
import { ingressLeaseHeld, readAgentIngressRow, type AgentIngressRow } from "@/lib/hivra/ingress/store";
import { deriveIngressTicketKey, resolveIngressSecret } from "@/lib/hivra/ingress/route-file";

type Env = Record<string, string | undefined>;

/** How far ahead a ticket expires. The proxy refuses any further than 120 s ahead. */
export const INGRESS_TICKET_TTL_S = 60;
/** The whole ticket call: the proxy's own wake plus its guest health check (3 s) fit well inside. */
export const INGRESS_WAKE_TIMEOUT_MS = 8_000;

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Whether host ingress was ever set up on this deployment: HIVRA_HOST_INGRESS
 * is set to anything (off included, the kill switch), or the ingress secret is.
 * When it is not, sleep and wake never read an ingress row and run exactly as
 * before.
 */
export function hostIngressConfigured(env: Env = process.env): boolean {
  return String(env.HIVRA_HOST_INGRESS ?? "").trim() !== "" || resolveIngressSecret(env) !== null;
}

export interface AgentIngressState {
  row: AgentIngressRow;
  /** The host serves this agent's public connector (mode is not guest): scripts use the ingress variants. */
  hostIngress: boolean;
  /** Ingress code may act on it: every switch on, mode host, cut over, no enable or rollback running. */
  acts: boolean;
  /** Served by the host while ingress may not act on it: wake it and never nap it. */
  needsAwake: boolean;
  /** An enable or rollback holds the agent now. */
  leaseHeld: boolean;
}

/** Pure: what one ingress row means, given the host row and env. */
export function agentIngressStateFrom(
  row: AgentIngressRow,
  host: IngressHostRow | null,
  input: { vmid: number; hostId: string; env?: Env; nowMs?: number },
): AgentIngressState {
  const env = input.env ?? process.env;
  const mode = parseAgentIngressMode(row.mode);
  const hostIngress = mode !== "guest";
  const leaseHeld = ingressLeaseHeld(row, input.nowMs);
  // A row written for another computer or host is not this one's: keep it awake until a human looks.
  const sameComputer = row.vmid === input.vmid && row.host_id === input.hostId;
  const acts = mode === "host" && sameComputer && row.phase === "cutover" && !leaseHeld && ingressActsFor(row, host, env);
  const needsAwake = hostIngress && !leaseHeld && (ingressNeedsAwake(row, host, env) || !acts);
  return { row, hostIngress, acts, needsAwake, leaseHeld };
}

async function readHostRow(hostId: string): Promise<IngressHostRow | null> {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  const { data, error } = await supabaseAdmin.from("proxmox_hosts").select("id, ingress_mode").eq("id", hostId).maybeSingle();
  if (error) throw new Error("host_read_failed");
  return (data as IngressHostRow | null) ?? null;
}

export type LoadedIngressState =
  | { kind: "none" }
  | { kind: "error" }
  | { kind: "row"; state: AgentIngressState };

/**
 * The agent's ingress state for a sleep or wake. `none` when ingress is not
 * configured here or the agent has no row (everything runs as before);
 * `error` when it could not be read (the caller keeps the agent awake, or
 * wakes it the old way).
 */
export async function loadAgentIngressState(
  agentId: string,
  input: { vmid: number; hostId: string; env?: Env; nowMs?: number },
  deps: {
    readRow?: (agentId: string) => Promise<AgentIngressRow | null>;
    readHost?: (hostId: string) => Promise<IngressHostRow | null>;
  } = {},
): Promise<LoadedIngressState> {
  const env = input.env ?? process.env;
  if (!hostIngressConfigured(env)) return { kind: "none" };
  try {
    const row = await (deps.readRow ?? readAgentIngressRow)(agentId);
    if (!row) return { kind: "none" };
    const host = await (deps.readHost ?? readHostRow)(input.hostId);
    return { kind: "row", state: agentIngressStateFrom(row, host, { ...input, env }) };
  } catch {
    return { kind: "error" };
  }
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/** v1.<exp>.<nonce>.<hmac>, the same form and MAC the proxy checks (hivra-wake-proxy.py ticket_mac). */
export function mintIngressTicket(input: { key: string; vmid: number; expS: number; nonce?: string }): string {
  if (!HEX64.test(input.key)) throw new Error("Invalid ticket key.");
  if (!Number.isSafeInteger(input.vmid) || input.vmid < 100) throw new Error("Invalid VMID.");
  if (!Number.isSafeInteger(input.expS) || input.expS <= 0) throw new Error("Invalid expiry.");
  const nonce = input.nonce ?? randomBytes(18).toString("base64url");
  if (!NONCE.test(nonce)) throw new Error("Invalid nonce.");
  const message = `wake\u0000${input.vmid}\u0000${input.expS}\u0000${nonce}`;
  const mac = createHmac("sha256", Buffer.from(input.key, "hex")).update(message, "utf8").digest("hex");
  return `v1.${input.expS}.${nonce}.${mac}`;
}

export interface IngressWakeReceipt {
  vmid: number;
  woke: "nap" | "already";
  ms: number;
  contMs: number;
  guestMs: number;
}

/** Strict read of the proxy's 200 answer. null for anything else. */
export function parseIngressWakeReceipt(value: unknown, vmid: number): IngressWakeReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.vmid !== vmid) return null;
  if (v.woke !== "nap" && v.woke !== "already") return null;
  if ("error" in v) return null;
  const ms = (x: unknown) => (Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= 600_000 ? (x as number) : null);
  const total = ms(v.ms);
  const cont = ms(v.cont_ms ?? 0);
  const guest = ms(v.guest_ms ?? 0);
  if (total === null || cont === null || guest === null) return null;
  return { vmid, woke: v.woke, ms: total, contMs: cont, guestMs: guest };
}

export type IngressWakeResult =
  | { ok: true; receipt: IngressWakeReceipt; ms: number }
  | { ok: false; reason: string; status?: number; ms: number };

/**
 * One ticket wake. ok only on a 200 whose receipt names this VM and says it
 * is running with a healthy guest. Never throws.
 */
export async function wakeViaIngress(
  input: {
    agentId: string;
    vmid: number;
    hostname: unknown;
    tunnelId: unknown;
    generation: number;
    env?: Env;
    nowMs?: number;
    timeoutMs?: number;
  },
  deps: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response> } = {},
): Promise<IngressWakeResult> {
  const startedAt = Date.now();
  const done = (reason: string, status?: number): IngressWakeResult =>
    ({ ok: false, reason, ...(status !== undefined ? { status } : {}), ms: Date.now() - startedAt });
  const secret = resolveIngressSecret(input.env ?? process.env);
  if (!secret) return done("no_secret");
  if (typeof input.hostname !== "string" || !HOSTNAME.test(input.hostname)) return done("no_hostname");
  if (typeof input.tunnelId !== "string") return done("no_tunnel");
  let ticket: string;
  try {
    const key = deriveIngressTicketKey({ secret, agentId: input.agentId, tunnelId: input.tunnelId, generation: input.generation });
    const nowS = Math.floor((input.nowMs ?? Date.now()) / 1000);
    ticket = mintIngressTicket({ key, vmid: input.vmid, expS: nowS + INGRESS_TICKET_TTL_S });
  } catch {
    return done("ticket_invalid");
  }
  const fetchImpl = deps.fetchImpl ?? ssrfSafeFetch;
  let response: Response;
  try {
    response = await fetchImpl(`https://${input.hostname.toLowerCase()}/__hivra/wake`, {
      method: "POST",
      cache: "no-store",
      redirect: "manual",
      headers: { "X-Hivra-Wake": ticket },
      signal: AbortSignal.timeout(input.timeoutMs ?? INGRESS_WAKE_TIMEOUT_MS),
    });
  } catch (error) {
    return done(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "unreachable");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return done(response.status === 403 ? "refused" : "status", response.status);
  }
  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > 4096) return done("bad_receipt", 200);
    body = JSON.parse(text);
  } catch {
    return done("bad_receipt", 200);
  }
  const receipt = parseIngressWakeReceipt(body, input.vmid);
  if (!receipt) return done("bad_receipt", 200);
  return { ok: true, receipt, ms: Date.now() - startedAt };
}
