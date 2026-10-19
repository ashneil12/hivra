import "server-only";

// Keeps each agent's kit (key, CLI, skill, list of computers) current on the
// agent's own computer. It runs after a link changes and on the agent's poll,
// and only when what the agent should have differs from what Hivra last
// delivered, or the key was never confirmed.
//
// Every delivery mints a fresh key. It is accepted as soon as it is minted
// (pending), so the agent is never refused its own key while the files are
// being written, and becomes the confirmed key when the computer answers.

import { randomBytes } from "node:crypto";
import { runProxmoxHostScript, type HostScriptResult } from "@/lib/services/proxmox-instance-service";
import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProviderAgentGuestScript } from "@/lib/hivra/provider-guest-seed";
import { log } from "@/lib/logger";
import { computerKindLabel, linkLabel, linkSource } from "./eligibility";
import { HIVRA_COMPUTERS_CLI, KIT_CLI_VERSION, buildKitGuestScript, parseKitOutput, renderComputersNote,
  renderComputersSkill, type KitComputer, type KitOutcome, type KitRequest } from "./kit-program";
import { db, loadKeyRecord, loadLinks, loadOwnedRow, loadOwnedRows, sha256Hex, type OwnedRow } from "./store";

/** One claim covers a round trip; a crashed one is taken over after this. */
const CLAIM_SECONDS = 45;
const PROXMOX_BUDGET_MS = 25_000;
const RETRY_AFTER_FAILURE_MS = 60_000;

export type KitState =
  | "delivered" | "pending" | "failed" | "not_needed" | "not_supported" | "waiting_for_agent";

export interface KitDeliveryResult {
  state: KitState;
  message?: string;
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** The kit the agent should have now, with the digest of its non-secret parts. */
export async function desiredKit(userId: string, agent: OwnedRow, endpoint: string) {
  const [links, rows] = await Promise.all([loadLinks(userId, { agentId: agent.id }), loadOwnedRows(userId)]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const computers: KitComputer[] = links.flatMap((link) => {
    const row = byId.get(link.computer_id);
    return row ? [{ id: row.id, name: linkLabel(row.name), kind: computerKindLabel(row) }] : [];
  });
  const mode: KitRequest["mode"] = computers.length > 0 ? "install" : "remove";
  const note = mode === "install" ? renderComputersNote(String(agent.name ?? "this agent"), computers) : undefined;
  const skill = mode === "install" ? renderComputersSkill(computers) : undefined;
  const digest = sha256Hex(JSON.stringify({ v: KIT_CLI_VERSION, mode, endpoint, agentId: agent.id, cli: HIVRA_COMPUTERS_CLI, note, skill }));
  return { mode, computers, note, skill, digest };
}

/** Whether the agent's own computer can take its kit right now, and why not. */
function agentReachable(agent: OwnedRow): string | null {
  if (agent.status !== "running") return "The agent's computer isn't running. Its computers reach it when it starts.";
  if (typeof agent.ip !== "string" || !agent.ip) return "The agent's computer isn't ready yet.";
  if (linkSource(agent).ok && agent.computer_substrate !== "provider-vm" && !agent.bootstrapped_at) {
    return "The agent is still being set up.";
  }
  return null;
}

// Same host lane and key as the Computer Contract seed: the guest script is
// wrapped again so no request byte reaches the host's shell unencoded.
function buildProxmoxHostScript(ip: string, guestScript: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
KEY=/etc/hivra/keys/vm-orchestrator
[ -f "$KEY" ] || { echo "vm key $KEY missing" >&2; exit 1; }
OUTER='${b64(guestScript)}'
ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o BatchMode=yes "ubuntu@${ip}" "echo '$OUTER' | base64 -d | sudo bash"
`;
}

async function runKit(userId: string, agent: OwnedRow, request: KitRequest): Promise<KitOutcome | null> {
  const script = buildKitGuestScript(request);
  if (agent.computer_substrate === "provider-vm") {
    const outcome = await runProviderAgentGuestScript({ userId, agentId: agent.id }, script);
    return outcome.ok ? parseKitOutput(outcome.stdout) : null;
  }
  const ip = String(agent.ip ?? "");
  if (!/^[0-9.]+$/.test(ip)) return null;
  const context = await resolveHivraAgentExecutionContext(userId, agent);
  let result: HostScriptResult;
  try {
    result = await runProxmoxHostScript(buildProxmoxHostScript(ip, script), context.env, PROXMOX_BUDGET_MS);
  } catch {
    return null;
  }
  return result.ok ? parseKitOutput(result.stdout || "") : null;
}

/** The single-flight claim, on the database's own rows. */
async function claim(userId: string, agentId: string): Promise<boolean> {
  const now = new Date(), stale = new Date(now.getTime() - CLAIM_SECONDS * 1000).toISOString();
  await db().from("hivra_agent_link_keys").upsert({ agent_id: agentId, user_id: userId }, { onConflict: "agent_id", ignoreDuplicates: true });
  const { data, error } = await db().from("hivra_agent_link_keys").update({ delivery_claimed_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("agent_id", agentId).eq("user_id", userId).or(`delivery_claimed_at.is.null,delivery_claimed_at.lt.${stale}`)
    .select("agent_id");
  if (error) throw new Error("database_unavailable");
  return (data ?? []).length === 1;
}

/**
 * Bring one agent's kit up to date. Never throws for a computer that can't be
 * reached: the state says so and the next poll tries again.
 */
export async function syncAgentLinkKit(userId: string, agentId: string, endpoint: string,
  options: { force?: boolean } = {}): Promise<KitDeliveryResult> {
  const agent = await loadOwnedRow(userId, agentId);
  if (!agent) return { state: "not_supported", message: "This agent no longer exists." };
  const source = linkSource(agent);
  if (!source.ok) return { state: "not_supported", message: source.reason };
  const kit = await desiredKit(userId, agent, endpoint);
  const record = await loadKeyRecord(agentId);
  if (kit.mode === "remove" && (!record || (!record.key_sha256 && !record.pending_key_sha256 && record.kit_sha256 === kit.digest))) {
    return { state: "not_needed" };
  }
  const confirmed = record?.kit_sha256 === kit.digest && (kit.mode === "remove" || Boolean(record?.key_sha256));
  if (confirmed && !options.force) return { state: "delivered" };
  const unreachable = agentReachable(agent);
  if (unreachable) return { state: "waiting_for_agent", message: unreachable };
  // A failed round trip is not repeated by every page load.
  if (!options.force && record?.last_error && Date.now() - Date.parse(record.updated_at) < RETRY_AFTER_FAILURE_MS) {
    return { state: "failed", message: kitFailureCopy(record.last_error) };
  }
  if (!(await claim(userId, agentId))) return { state: "pending", message: "Hivra is updating the agent now." };

  const key = kit.mode === "install" ? `hvl_${randomBytes(32).toString("hex")}` : null;
  const pending = key ? sha256Hex(key) : null;
  await db().from("hivra_agent_link_keys").update({ pending_key_sha256: pending, updated_at: new Date().toISOString() })
    .eq("agent_id", agentId).eq("user_id", userId);
  const request: KitRequest = kit.mode === "install"
    ? { mode: "install", cli: HIVRA_COMPUTERS_CLI, link: { endpoint, key: key!, agentId }, note: kit.note, skill: kit.skill }
    : { mode: "remove", cli: HIVRA_COMPUTERS_CLI };

  let outcome: KitOutcome | null = null;
  try {
    outcome = await runKit(userId, agent, request);
  } catch (error) {
    log.warn("agent link kit delivery failed", { source: "agent-links/kit", failureType: "agent_link_kit_transport",
      userId, agentId, errorMessage: error instanceof Error ? error.message : String(error) });
  }
  const now = new Date().toISOString();
  if (outcome?.status === "delivered") {
    await db().from("hivra_agent_link_keys").update({
      key_sha256: pending, pending_key_sha256: null, kit_sha256: kit.digest, delivered_at: now,
      delivery_claimed_at: null, last_error: null, updated_at: now,
    }).eq("agent_id", agentId).eq("user_id", userId);
    return { state: "delivered" };
  }
  const reason = outcome?.status === "refused" ? outcome.reason : "unreachable";
  log.warn("agent link kit not delivered", { source: "agent-links/kit", failureType: "agent_link_kit_not_delivered", userId, agentId, reason });
  await db().from("hivra_agent_link_keys").update({ delivery_claimed_at: null, last_error: reason, updated_at: now })
    .eq("agent_id", agentId).eq("user_id", userId);
  return { state: "failed", message: kitFailureCopy(reason) };
}

export function kitFailureCopy(reason: string | null | undefined): string {
  switch (reason) {
    case "no_agent_user": return "Hivra couldn't find the agent's user on its computer.";
    case "cli_write_failed":
    case "home_write_failed": return "Hivra couldn't write the agent's files on its computer.";
    default: return "Hivra couldn't reach the agent's computer. It tries again while you have the agent open.";
  }
}

/** What Manage shows about one agent's kit, without contacting anything. */
export async function readKitState(userId: string, agent: OwnedRow, endpoint: string): Promise<KitDeliveryResult> {
  const source = linkSource(agent);
  if (!source.ok) return { state: "not_supported", message: source.reason };
  const [kit, record] = await Promise.all([desiredKit(userId, agent, endpoint), loadKeyRecord(agent.id)]);
  if (kit.mode === "remove" && (!record || !record.key_sha256)) return { state: "not_needed" };
  if (record?.kit_sha256 === kit.digest && (kit.mode === "remove" || record.key_sha256)) return { state: "delivered" };
  const unreachable = agentReachable(agent);
  if (unreachable) return { state: "waiting_for_agent", message: unreachable };
  if (record?.last_error) return { state: "failed", message: kitFailureCopy(record.last_error) };
  return { state: "pending", message: "Hivra is telling the agent about its computers." };
}

/** The agent API's address as this deployment serves it. */
export function agentLinkEndpoint(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/agent-link`;
}
