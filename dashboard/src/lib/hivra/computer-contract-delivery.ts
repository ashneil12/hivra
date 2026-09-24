import "server-only";

// Keeps an agent's Computer Contract current on its computer and reports what
// Manage may say about it.
//
// Hivra Cloud and My server (Proxmox) and My cloud (provider VMs): the
// revisioned guest seed lanes, which run the same guest program. Revision N
// is written only over the block Hivra last delivered (compare-and-swap),
// read back in the same call, and marked delivered only when the digest the
// computer reports equals revision N's. An edited copy is never overwritten
// automatically; Manage offers Restore.
//
// DigitalOcean: the note is a visible first "Hivra setup" message
// (do-managed-sessions.ts sends it); this module prepares and records it.

import { log } from "@/lib/logger";
import {
  computerContractPlanFor,
  type ComputerContractSubject,
} from "@/lib/agent-computers/computer-contract-input";
import { computerContractStatusFromRows, type ComputerContractStatus } from "@/lib/agent-computers/computer-contract-status";
import {
  ensureComputerContractRevision,
  loadComputerContracts,
  recordComputerContractAttempt,
  recordComputerContractChecked,
  recordComputerContractConflict,
  recordComputerContractDelivered,
  recordComputerContractError,
  recordComputerContractIntact,
  type ComputerContractRow,
} from "./computer-contract-store";
import {
  runComputerContractSeed,
  runProviderComputerContractSeed,
  type ComputerContractGuestOutcome,
  type ComputerContractGuestRequest,
} from "./computer-contract-seed";

type ProxmoxEnvironment = Parameters<typeof runComputerContractSeed>[2];
type AgentRow = ComputerContractSubject & { id: string; ip?: string | null };

const LOG_SOURCE = "hivra/computer-contract";
/** An automatic retry waits this long after the last attempt. */
export const COMPUTER_CONTRACT_RETRY_MS = 60_000;

type Dependencies = {
  seed: typeof runComputerContractSeed;
  providerSeed: typeof runProviderComputerContractSeed;
  now: () => Date;
};
const defaults: Dependencies = { seed: runComputerContractSeed, providerSeed: runProviderComputerContractSeed, now: () => new Date() };

/** One bounded round trip to the computer with the fixed guest program. */
type Send = (request: ComputerContractGuestRequest) => Promise<ComputerContractGuestOutcome>;
type SeedChannel = "proxmox-seed" | "provider-seed";
export type ComputerContractMode = "auto" | "deliver" | "restore" | "check";

function subjectOf(agent: Record<string, unknown>): AgentRow {
  return agent as unknown as AgentRow;
}

/** What Manage shows, from stored rows only. Never contacts the computer. */
export async function computerContractStatusFor(userId: string, rawAgent: Record<string, unknown>): Promise<ComputerContractStatus> {
  const agent = subjectOf(rawAgent);
  const plan = computerContractPlanFor(agent);
  if (plan.status === "not_applicable") return { kind: "not_applicable", reason: plan.reason };
  return computerContractStatusFromRows(plan.channel, await loadComputerContracts(userId, agent.id));
}

/** The facts file written next to the block (~/.hivra/computer.json). */
export function computerContractFacts(row: ComputerContractRow): Record<string, unknown> {
  const input = row.input;
  return {
    source: "hivra",
    schema: 1,
    revision: row.revision,
    contentSha256: row.content_sha256,
    instructionsFile: "/home/bux/system-prompt.md",
    agent: { label: input.agentLabel, runtime: input.runtime },
    computer: {
      relation: "own",
      placement: input.placement,
      os: "ubuntu-linux",
      reserved: { cpu: input.resources.cpu, memoryGb: input.resources.memoryGb },
      maximum: { cpu: input.resources.cpuMax, memoryGb: input.resources.memoryMaxGb },
    },
    account: { user: "bux", administrator: true, workspace: "/home/bux" },
    surfaces: input.surfaces,
    browser: input.browser === "toggle"
      ? { control: "Manage → Browser automation", liveCheck: "systemctl is-active bux-local-browser" }
      : null,
    tools: input.tools,
  };
}

function newestDelivered(rows: readonly ComputerContractRow[]): ComputerContractRow | null {
  return rows.find((row) => row.delivered_at !== null && row.receipt !== null) ?? null;
}

function request(row: ComputerContractRow, mode: ComputerContractGuestRequest["mode"], expected: string): ComputerContractGuestRequest {
  return { mode, expected, revision: row.revision, block: row.content, contentSha256: row.content_sha256, facts: computerContractFacts(row) };
}

/**
 * Advance the seeded delivery of the agent's current revision.
 *
 * - `auto` (the agent poll): mint a revision if the input changed, then
 *   deliver it unless it is delivered, in conflict, or was tried within the
 *   last minute.
 * - `deliver` (Try again): the same, without the retry wait.
 * - `restore` (Restore, an explicit owner action): replace an edited copy.
 * - `check` (Check again): read the computer's copy without writing.
 *
 * Returns the status after the step. A transport failure is recorded as
 * unreachable and never changes the delivery state.
 */
async function advanceSeededComputerContract(
  userId: string,
  rawAgent: Record<string, unknown>,
  channel: SeedChannel,
  send: Send,
  mode: ComputerContractMode,
  now: () => Date,
): Promise<ComputerContractStatus> {
  const agent = subjectOf(rawAgent);
  const plan = computerContractPlanFor(agent);
  if (plan.status !== "deliverable" || plan.channel !== channel) return computerContractStatusFor(userId, rawAgent);
  if (agent.status !== "running" || !agent.ip) {
    return computerContractStatusFromRows(plan.channel, await loadComputerContracts(userId, agent.id));
  }
  const ensured = await ensureComputerContractRevision({ userId, agentId: agent.id, channel: plan.channel, contract: plan.input });
  if (!ensured) return { kind: "unavailable" };
  let { latest } = ensured;
  const { rows } = ensured;
  const status = (current: ComputerContractRow) => computerContractStatusFromRows(plan.channel, [current, ...rows.filter((row) => row.id !== current.id)]);
  const at = now();

  if (mode === "check") {
    const outcome = await send(request(latest, "check", "absent"));
    if (!outcome.ok || outcome.result.status !== "observed") {
      latest = await recordComputerContractError(latest, outcome.ok ? outcome.result.status : outcome.error);
      return status(latest);
    }
    const observed = outcome.result.observed;
    if (observed === latest.content_sha256) {
      // Intact: a delivered copy stays delivered (and an edit the owner
      // reverted by hand clears); a pending one whose receipt was lost is
      // now read back and recorded.
      latest = latest.delivered_at && latest.receipt
        ? await recordComputerContractIntact(latest, at)
        : await recordComputerContractDelivered(latest, "delivered", {
          channel, revision: latest.revision, contentSha256: latest.content_sha256,
          observedSha256: observed, replay: true, bootId: outcome.result.bootId, attestedBy: "computer",
        }, at);
    } else if (!latest.delivered_at && (rows.some((row) => row.content_sha256 === observed)
      || (observed === "absent" && !newestDelivered(rows)))) {
      // Still an older Hivra revision (or none yet): the update is pending.
      latest = await recordComputerContractChecked(latest, at);
    } else {
      latest = await recordComputerContractConflict(latest, at);
    }
    return status(latest);
  }

  if (latest.delivery_state === "delivered" && mode !== "restore") return status(latest);
  if (latest.delivery_state === "conflict" && mode === "auto") return status(latest);
  if (mode === "auto" && latest.last_attempt_at && at.getTime() - Date.parse(latest.last_attempt_at) < COMPUTER_CONTRACT_RETRY_MS) {
    return status(latest);
  }

  latest = await recordComputerContractAttempt(latest, at);
  const delivered = newestDelivered(rows.filter((row) => row.id !== latest.id));
  let expected = delivered?.content_sha256 ?? "absent";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await send(request(latest, mode === "restore" ? "restore" : "deliver", expected));
    if (!outcome.ok) {
      log.warn("computer contract delivery did not complete", { source: LOG_SOURCE, failureType: "computer_contract_delivery_unconfirmed", agentId: agent.id, revision: latest.revision, reason: outcome.error });
      latest = await recordComputerContractError(latest, outcome.error);
      return status(latest);
    }
    const result = outcome.result;
    if (result.status === "delivered") {
      if (result.revision !== latest.revision || result.contentSha256 !== latest.content_sha256) {
        latest = await recordComputerContractError(latest, "readback_mismatch");
        return status(latest);
      }
      latest = await recordComputerContractDelivered(latest, "delivered", {
        channel,
        revision: result.revision,
        contentSha256: result.contentSha256,
        observedSha256: result.observed,
        replay: result.replay,
        bootId: result.bootId,
        // Read back over Hivra's own connection. The agent has sudo on its
        // own computer, so this is the computer's report, not an
        // independent check.
        attestedBy: "computer",
      }, now());
      return status(latest);
    }
    if (result.status === "state_conflict") {
      // The block is a revision Hivra wrote whose receipt was lost: swap
      // from that one instead of calling it an edit.
      const known = rows.find((row) => row.content_sha256 === result.observed);
      if (attempt === 0 && known && result.observed !== expected) {
        expected = result.observed;
        continue;
      }
      latest = await recordComputerContractConflict(latest, now());
      return status(latest);
    }
    latest = await recordComputerContractError(latest, result.status);
    return status(latest);
  }
  return status(latest);
}

/** Hivra Cloud and My server: the Proxmox host-to-guest seed lane. */
export async function advanceProxmoxComputerContract(
  userId: string,
  rawAgent: Record<string, unknown>,
  env: ProxmoxEnvironment,
  mode: ComputerContractMode,
  dependencies: Partial<Dependencies> = {},
): Promise<ComputerContractStatus> {
  const deps = { ...defaults, ...dependencies };
  const ip = String(rawAgent.ip ?? "");
  return advanceSeededComputerContract(userId, rawAgent, "proxmox-seed", (guestRequest) => deps.seed(ip, guestRequest, env), mode, deps.now);
}

/** My cloud: the enrolled provider seed lane (provider-guest-seed.ts). */
export async function advanceProviderComputerContract(
  userId: string,
  rawAgent: Record<string, unknown>,
  mode: ComputerContractMode,
  dependencies: Partial<Dependencies> = {},
): Promise<ComputerContractStatus> {
  const deps = { ...defaults, ...dependencies };
  const ref = { userId, agentId: String(rawAgent.id) };
  return advanceSeededComputerContract(userId, rawAgent, "provider-seed", (guestRequest) => deps.providerSeed(ref, guestRequest), mode, deps.now);
}

// ── DigitalOcean ───────────────────────────────────────────────────────────

/** The revision to send as a DigitalOcean session's visible setup note. */
export async function prepareDigitalOceanComputerContract(userId: string, rawAgent: Record<string, unknown>): Promise<ComputerContractRow | null> {
  const agent = subjectOf(rawAgent);
  const plan = computerContractPlanFor(agent);
  if (plan.status !== "deliverable" || plan.channel !== "do-setup-message") return null;
  const ensured = await ensureComputerContractRevision({ userId, agentId: agent.id, channel: plan.channel, contract: plan.input });
  return ensured?.latest ?? null;
}

/** DigitalOcean accepted the message and returned its run. Not "delivered". */
export async function recordDigitalOceanComputerContractSent(row: ComputerContractRow, runId: string | null, at: Date): Promise<ComputerContractRow> {
  return recordComputerContractDelivered(row, "sent", { channel: "do-setup-message", runId, revision: row.revision, contentSha256: row.content_sha256 }, at);
}

export async function recordDigitalOceanComputerContractFailed(row: ComputerContractRow, at: Date): Promise<ComputerContractRow> {
  const attempted = await recordComputerContractAttempt(row, at);
  return recordComputerContractError(attempted, "send_failed");
}
