import "server-only";

// The local bridge's rules, in one place.
//
// - A request is stored `pending`. Nothing reaches the owner's computer until a
//   row is moved approved -> running by `dispatch`, and only that path mints a
//   ticket. The owner's approval (or a live 1-hour allowance for that agent on
//   that computer) is what makes a row `approved`.
// - A ticket is bound to the owner, the agent, the computer and the exact argv,
//   lives 60 s and works once on the bridge.
// - There is no allow-forever: an allowance is at most one hour.

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  generateBridgeKey, bridgeArgvHash, execViaRelay, hostRelayStatus, HostRelayError, issueBridgeConfig, mintBridgeTicket,
  revokeRelayConnector,
} from "@/lib/infrastructure/host-relay";
import { log } from "@/lib/logger";
import * as store from "./store";
import type { BridgeComputer, BridgeRequest } from "./store";

export const BRIDGE_OFF_MESSAGE = "The bridge on your computer is off.";
export const REQUEST_TTL_MS = 10 * 60_000;
export const ALLOWANCE_MS = 60 * 60_000;
export const MAX_PENDING_PER_AGENT = 5;
export const LIMITS = { timeoutMax: 120, timeoutDefault: 30, outputMax: 1024 * 1024, outputDefault: 256 * 1024, argvItems: 64, argLength: 4096 } as const;

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; message: string };
const fail = (status: number, message: string): { ok: false; status: number; message: string } => ({ ok: false, status, message });

export type SubmitInput = { argv: string[]; cwd?: string | null; timeoutSeconds?: number; maxOutputBytes?: number };

/** Output is kept for 7 days; past that it reads as gone (and is nulled in the table on the owner's next read). */
export function withoutOldResult(row: BridgeRequest, now: number): BridgeRequest {
  const finished = row.finished_at ? Date.parse(row.finished_at) : NaN;
  return row.result && Number.isFinite(finished) && now - finished > store.RESULT_RETENTION_MS ? { ...row, result: null } : row;
}

/** What the agent and the owner see of a request. */
export function publicRequest(row: BridgeRequest, includeResult = true) {
  return {
    id: row.id, agentId: row.agent_id, computerId: row.computer_id, argv: row.argv, cwd: row.cwd, status: row.status,
    decision: row.decision, createdAt: row.created_at, expiresAt: row.expires_at, finishedAt: row.finished_at, errorCode: row.error_code,
    ...(includeResult && row.result ? { result: row.result } : {}),
  };
}

export function allowanceActive(allowance: { granted_at: string; expires_at: string } | null, now: number): boolean {
  if (!allowance) return false;
  const granted = Date.parse(allowance.granted_at);
  const expires = Date.parse(allowance.expires_at);
  return Number.isFinite(granted) && Number.isFinite(expires) && expires > now && expires - granted <= ALLOWANCE_MS;
}

/** Whether this computer's bridge is switched on right now. */
async function bridgeOnline(computer: BridgeComputer): Promise<boolean> {
  if (computer.revoked_at) return false;
  try {
    return (await hostRelayStatus(computer.id)).online;
  } catch (error) {
    if (error instanceof HostRelayError && error.code === "not_configured") return false;
    throw error;
  }
}

export async function submitRequest(
  userId: string, agentId: string, computerId: string, input: SubmitInput, now: number = Date.now(),
): Promise<Result<{ request: BridgeRequest; dispatchNow: boolean }>> {
  const computer = await store.loadComputer(userId, computerId);
  if (!computer) return fail(404, "That computer is not set up for the bridge.");
  if (!(await bridgeOnline(computer))) return fail(409, BRIDGE_OFF_MESSAGE);
  if ((await store.countPending(agentId)) >= MAX_PENDING_PER_AGENT) return fail(429, "Too many requests are waiting for approval.");
  const request = await store.insertRequest({
    userId, agentId, computerId, argv: input.argv, argvSha256: bridgeArgvHash(input.argv), cwd: input.cwd ?? null,
    timeoutSeconds: input.timeoutSeconds ?? LIMITS.timeoutDefault, maxOutputBytes: input.maxOutputBytes ?? LIMITS.outputDefault,
    expiresAt: new Date(now + REQUEST_TTL_MS).toISOString(),
  });
  const allowance = await store.findAllowance(userId, agentId, computerId);
  if (allowanceActive(allowance, now)) {
    const approved = await store.transition(request.id, "pending", { status: "approved", decision: "allowance", decided_at: new Date(now).toISOString() });
    if (approved) return { ok: true, value: { request: { ...request, status: "approved", decision: "allowance" }, dispatchNow: true } };
  }
  return { ok: true, value: { request, dispatchNow: false } };
}

export type Decision = "approve" | "deny" | "allow_hour";

export async function decideRequest(userId: string, requestId: string, decision: Decision, now: number = Date.now()): Promise<Result<{ request: BridgeRequest; dispatchNow: boolean }>> {
  const request = await store.loadRequest(userId, requestId);
  if (!request) return fail(404, "That request was not found.");
  if (request.status !== "pending") return fail(409, "That request was already decided.");
  if (Date.parse(request.expires_at) <= now) {
    await store.transition(request.id, "pending", { status: "expired", finished_at: new Date(now).toISOString() });
    return fail(409, "That request has expired. Ask the agent to try again.");
  }
  const decidedAt = new Date(now).toISOString();
  if (decision === "deny") {
    if (!(await store.transition(request.id, "pending", { status: "denied", decision: "deny", decided_at: decidedAt, finished_at: decidedAt }))) return fail(409, "That request was already decided.");
    return { ok: true, value: { request: { ...request, status: "denied", decision: "deny" }, dispatchNow: false } };
  }
  if (decision === "allow_hour") {
    await store.upsertAllowance(userId, request.agent_id, request.computer_id, decidedAt, new Date(now + ALLOWANCE_MS).toISOString());
  }
  if (!(await store.transition(request.id, "pending", { status: "approved", decision, decided_at: decidedAt }))) return fail(409, "That request was already decided.");
  return { ok: true, value: { request: { ...request, status: "approved", decision }, dispatchNow: true } };
}

/**
 * Runs an approved request. The only place a ticket is minted, and only for a
 * row this call moved approved -> running, so a pending, denied, expired or
 * already-running request never gets one.
 */
export async function dispatchRequest(userId: string, requestId: string, now: number = Date.now()): Promise<void> {
  const request = await store.loadRequest(userId, requestId);
  if (!request || request.status !== "approved") return;
  const claimed = await store.transition(request.id, "approved", { status: "running", dispatched_at: new Date(now).toISOString() });
  if (!claimed) return;
  const finish = (patch: Record<string, unknown> & { status: "done" | "failed" }) =>
    store.transition(request.id, "running", { ...patch, finished_at: new Date().toISOString() });
  try {
    const computer = await store.loadComputer(userId, request.computer_id);
    if (!computer?.bridge_key_encrypted || computer.revoked_at) throw new HostRelayError("host_offline", BRIDGE_OFF_MESSAGE);
    const ticket = mintBridgeTicket(decryptSecret(computer.bridge_key_encrypted), { ownerId: userId, agentId: request.agent_id, computerId: request.computer_id, argv: request.argv, cwd: request.cwd }, now);
    const reply = await execViaRelay(request.computer_id, ticket, {
      argv: request.argv, ...(request.cwd ? { cwd: request.cwd } : {}), timeoutSeconds: request.timeout_seconds, maxOutputBytes: request.max_output_bytes,
    });
    if (reply.ok) {
      await finish({ status: "done", result: { stdout: reply.stdout, stderr: reply.stderr, exitCode: reply.exitCode, truncated: reply.truncated, durationMs: reply.durationMs } });
    } else {
      await finish({ status: "failed", error_code: String(reply.error).slice(0, 80), result: { message: String(reply.message ?? "The bridge refused the command.").slice(0, 300) } });
    }
  } catch (error) {
    const off = error instanceof HostRelayError && (error.code === "host_offline" || error.code === "not_configured");
    log.warn("Local bridge command did not run", { source: "local-bridge", failureType: "bridge_dispatch_failed", errorCode: error instanceof HostRelayError ? error.code : "unknown" });
    await finish({ status: "failed", error_code: off ? "bridge_off" : "bridge_unavailable", result: { message: off ? BRIDGE_OFF_MESSAGE : "Your computer's bridge did not answer." } });
  }
}

/** The agent's poll: a pending request past its time is reported (and stored) as expired. */
export async function readRequestForAgent(userId: string, agentId: string, requestId: string, now: number = Date.now()): Promise<Result<BridgeRequest>> {
  let request = await store.loadRequestForAgent(userId, agentId, requestId);
  if (!request) return fail(404, "That request was not found.");
  request = withoutOldResult(request, now);
  if (request.status === "pending" && Date.parse(request.expires_at) <= now) {
    await store.transition(request.id, "pending", { status: "expired", finished_at: new Date(now).toISOString() });
    request = { ...request, status: "expired" };
  }
  return { ok: true, value: request };
}

export async function enrollComputer(userId: string, label: string, computerId?: string) {
  // A new random key every time: re-enrolling rotates it, so an old config stops working.
  const key = generateBridgeKey();
  let computer: BridgeComputer | null;
  if (computerId) {
    computer = await store.loadComputer(userId, computerId);
    if (!computer) return fail(404, "That computer was not found.");
    await store.markComputerEnrolled(userId, computer.id, encryptSecret(key));
  } else {
    computer = await store.insertComputer(userId, label, encryptSecret(key));
  }
  return { ok: true as const, value: { computer, config: issueBridgeConfig(computer.id, computer.generation, userId, key) } };
}

/** One action: raise the generation and tell the relay, which stops the bridge. */
export async function revokeComputer(userId: string, computerId: string): Promise<Result<{ generation: number }>> {
  const computer = await store.loadComputer(userId, computerId);
  if (!computer) return fail(404, "That computer was not found.");
  // The key rotates too: nothing the revoked bridge holds can sign a ticket again.
  const next = await store.bumpGeneration(userId, computer, encryptSecret(generateBridgeKey()));
  await revokeRelayConnector(computer.id, next);
  return { ok: true, value: { generation: next } };
}

export async function revokeAllowance(userId: string, agentId: string, computerId: string): Promise<void> {
  await store.deleteAllowance(userId, agentId, computerId);
}
