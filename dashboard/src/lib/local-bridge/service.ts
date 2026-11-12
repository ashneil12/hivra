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

import { createHash, randomBytes } from "node:crypto";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { trustedAppOrigin } from "@/lib/infrastructure/trusted-app-origin";
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

/** Pending requests past their time become expired, in the table and in what is returned. */
export async function expireStale(rows: BridgeRequest[], now: number = Date.now()): Promise<BridgeRequest[]> {
  return Promise.all(rows.map(async (row) => {
    if (row.status !== "pending" || Date.parse(row.expires_at) > now) return row;
    await store.transition(row.id, "pending", { status: "expired", finished_at: new Date(now).toISOString() });
    return { ...row, status: "expired" as const };
  }));
}

/** One request's output for its owner, on demand; gone after 7 days. */
export async function readResultForOwner(userId: string, requestId: string, now: number = Date.now()): Promise<Result<{ result: Record<string, unknown> | null }>> {
  const row = await store.loadRequest(userId, requestId);
  if (!row) return fail(404, "That request was not found.");
  return { ok: true, value: { result: withoutOldResult(row, now).result } };
}

/** What the agent and the owner see of a request. */
export function publicRequest(row: BridgeRequest, includeResult = true) {
  return {
    hasResult: Boolean(row.result),
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
  // Old output is cleared whenever a new request comes in, as well as by the daily cleanup.
  await store.purgeOldResults(userId, now).catch(() => undefined);
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
  // Approve first; the hour is granted only if this call is the one that approved it.
  if (!(await store.transition(request.id, "pending", { status: "approved", decision, decided_at: decidedAt }))) return fail(409, "That request was already decided.");
  if (decision === "allow_hour") {
    await store.upsertAllowance(userId, request.agent_id, request.computer_id, decidedAt, new Date(now + ALLOWANCE_MS).toISOString());
  }
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
    const ticket = mintBridgeTicket(decryptSecret(computer.bridge_key_encrypted), { ownerId: userId, agentId: request.agent_id, computerId: request.computer_id, argv: request.argv, cwd: request.cwd, timeoutSeconds: request.timeout_seconds, maxOutputBytes: request.max_output_bytes }, now);
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

/** A setup code works once and lasts 15 minutes. */
export const ENROL_CODE_TTL_MS = 15 * 60_000;
export const ENROL_CODE_PATTERN = /^hvb_[A-Za-z0-9_-]{32}$/;
const codeHash = (code: string) => createHash("sha256").update(`local-bridge-enrol|v1|${code}`).digest("hex");

export function bridgeInstallCommand(origin: string, code: string): string {
  return `curl -fsSL ${origin}/api/hivra/bridge/install | bash -s -- ${code}`;
}

/**
 * Sets a computer up (or sets it up again) and returns the one command to paste on it. The
 * secrets never leave the server here: the command carries a one-time code (stored only as a
 * hash), and the computer swaps it for its settings once, in `redeemEnrolCode`.
 */
export async function enrollComputer(userId: string, label: string, computerId?: string, now: number = Date.now()) {
  const origin = trustedAppOrigin();
  if (!origin) return fail(503, "This deployment has no public address to set a computer up from.");
  // A new random key every time. Re-enrolling also raises the generation and tells the relay,
  // so an old config (key and connector secret) stops working, and clears the old allowances.
  const key = generateBridgeKey();
  let computer: BridgeComputer | null;
  if (computerId) {
    computer = await store.loadComputer(userId, computerId);
    if (!computer) return fail(404, "That computer was not found.");
    const generation = await store.bumpGeneration(userId, computer, encryptSecret(key), false);
    await store.deleteAllowancesForComputer(userId, computer.id);
    await revokeRelayConnector(computer.id, generation);
  } else {
    computer = await store.insertComputer(userId, label, encryptSecret(key));
  }
  const code = `hvb_${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(now + ENROL_CODE_TTL_MS).toISOString();
  await store.setEnrolCode(userId, computer.id, codeHash(code), expiresAt);
  return { ok: true as const, value: { computer, command: bridgeInstallCommand(origin, code), expiresAt } };
}

/** The computer swaps its one-time code for its settings, once. Nothing else is returned or logged. */
export async function redeemEnrolCode(code: string, now: number = Date.now()): Promise<Result<ReturnType<typeof issueBridgeConfig>>> {
  if (!ENROL_CODE_PATTERN.test(code)) return fail(400, "That code can't be used.");
  const computer = await store.consumeEnrolCode(codeHash(code), new Date(now).toISOString());
  if (!computer?.bridge_key_encrypted) return fail(400, "That code has expired or was already used.");
  return { ok: true, value: issueBridgeConfig(computer.id, computer.generation, computer.user_id, decryptSecret(computer.bridge_key_encrypted)) };
}

/** One action: raise the generation and tell the relay, which stops the bridge. */
export async function revokeComputer(userId: string, computerId: string): Promise<Result<{ generation: number }>> {
  const computer = await store.loadComputer(userId, computerId);
  if (!computer) return fail(404, "That computer was not found.");
  // The key rotates too: nothing the revoked bridge holds can sign a ticket again.
  const next = await store.bumpGeneration(userId, computer, encryptSecret(generateBridgeKey()), true);
  // Nothing already allowed or waiting may run on a revoked computer.
  await store.deleteAllowancesForComputer(userId, computer.id);
  await store.expireOpenRequests(userId, computer.id);
  await revokeRelayConnector(computer.id, next);
  return { ok: true, value: { generation: next } };
}

export async function revokeAllowance(userId: string, agentId: string, computerId: string): Promise<void> {
  await store.deleteAllowance(userId, agentId, computerId);
}
