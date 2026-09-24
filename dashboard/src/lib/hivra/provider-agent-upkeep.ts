import "server-only";

// Keeps a running Claude Code or Codex agent on a computer in the owner's own
// cloud (a provider VM) up to date: the one-time launch seeds (ATT-05) and its
// Computer Contract. The agent poll schedules this after its response
// (after-response.ts), so an unreachable computer never slows the agent page.
//
// Each seed attempt reaches the computer over its enrolled provider pin, which
// also loads and checks the provider receipt and the administrator key. So an
// attempt is claimed in the database first (hivra_agents.provider_seed_attempted_at):
// concurrent page loads never overlap, and a seed that keeps failing is tried
// again after a minute while the computer is new, then every 15 minutes.
// Each part the computer confirms is stamped once and never sent again.

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { computerContractPlanFor, type ComputerContractSubject } from "@/lib/agent-computers/computer-contract-input";
import { logHivraAgentEvent } from "./agent-events";
import { advanceProviderComputerContract } from "./computer-contract-delivery";
import {
  providerAgentSeedsDue,
  seedProviderAgent,
  type ProviderAgentSeedPart,
  type ProviderAgentSeedRow,
} from "./provider-agent-seed";

const LOG_SOURCE = "hivra/provider-agent-upkeep";
/** While the computer is new, a seed that didn't confirm is tried again after this long. */
export const PROVIDER_SEED_RETRY_MS = 60_000;
/** Once the computer has settled, a seed that keeps failing is tried at most this often. */
export const PROVIDER_SEED_SETTLED_RETRY_MS = 15 * 60_000;
/** How long after the installer finished the computer counts as new. */
export const PROVIDER_SEED_LAUNCH_WINDOW_MS = 30 * 60_000;
/** One seed connection (provider-guest-seed.ts stops it at 30 s), with margin. */
const SEED_BUDGET_MS = 35_000;

const SEED_COLUMN: Record<ProviderAgentSeedPart, "bootstrapped_at" | "bankr_skills_seeded_at" | "template_skills_seeded_at"> = {
  bootstrap: "bootstrapped_at",
  "bankr-skills": "bankr_skills_seeded_at",
  "template-skills": "template_skills_seeded_at",
};
const SEED_EVENT: Record<ProviderAgentSeedPart, "bootstrapped" | "bankr_skills_seeded" | "template_skills_seeded"> = {
  bootstrap: "bootstrapped",
  "bankr-skills": "bankr_skills_seeded",
  "template-skills": "template_skills_seeded",
};

type UpkeepRow = Record<string, unknown>;

/** How long a seed attempt waits after the last one, for this computer now. */
export function providerSeedRetryWaitMs(row: { provider_install_stopped_at?: unknown }, now: Date): number {
  const installed = Date.parse(String(row.provider_install_stopped_at ?? ""));
  return Number.isFinite(installed) && now.getTime() - installed < PROVIDER_SEED_LAUNCH_WINDOW_MS
    ? PROVIDER_SEED_RETRY_MS
    : PROVIDER_SEED_SETTLED_RETRY_MS;
}

/**
 * Whether the agent poll should schedule upkeep for this row at all: a stable
 * running Claude Code or Codex agent on a provider computer.
 */
export function providerAgentUpkeepApplies(row: UpkeepRow): boolean {
  if (row.computer_substrate !== "provider-vm" || row.status !== "running" || row.operation_id || row.operation_kind) return false;
  if (providerAgentSeedsDue(row as unknown as ProviderAgentSeedRow).length > 0) return true;
  const plan = computerContractPlanFor(row as unknown as ComputerContractSubject);
  return Boolean(row.ip) && plan.status === "deliverable" && plan.channel === "provider-seed";
}

/**
 * Claim the next seed attempt: one conditional update, so only one request
 * wins and a recent attempt makes the others wait. "unavailable" when the
 * column isn't deployed yet or the update failed; nothing is sent then.
 */
async function claimSeedAttempt(userId: string, row: UpkeepRow, now: Date): Promise<"claimed" | "waiting" | "unavailable"> {
  if (!supabaseAdmin) return "unavailable";
  const cutoff = new Date(now.getTime() - providerSeedRetryWaitMs(row, now)).toISOString();
  const { data, error } = await supabaseAdmin.from("hivra_agents")
    .update({ provider_seed_attempted_at: now.toISOString() })
    .eq("id", String(row.id)).eq("user_id", userId).eq("computer_substrate", "provider-vm").eq("status", "running")
    .is("operation_id", null)
    .or(`provider_seed_attempted_at.is.null,provider_seed_attempted_at.lt.${cutoff}`)
    .select("id").maybeSingle();
  if (error) {
    log.warn("provider agent seed attempt could not be claimed", {
      source: LOG_SOURCE, failureType: "provider_agent_seed_claim_failed", userId, agentId: String(row.id), code: error.code,
    });
    return "unavailable";
  }
  return data ? "claimed" : "waiting";
}

type Dependencies = {
  seed: typeof seedProviderAgent;
  contract: typeof advanceProviderComputerContract;
  now: () => Date;
};
const defaults: Dependencies = { seed: seedProviderAgent, contract: advanceProviderComputerContract, now: () => new Date() };

/**
 * Send the seeds still due, then keep the Computer Contract current. Nothing
 * starts a round trip that can't finish before `deadline` (milliseconds on
 * the `now` clock); what doesn't fit waits for the next page load. Never
 * throws for a failed seed and never changes the computer's lifecycle.
 */
export async function advanceProviderAgentUpkeep(
  userId: string,
  agent: UpkeepRow,
  options: { deadline: number } & Partial<Dependencies>,
): Promise<void> {
  const deps = { ...defaults, ...options };
  if (!supabaseAdmin || !providerAgentUpkeepApplies(agent)) return;
  let current = agent;
  const agentId = String(agent.id);

  if (providerAgentSeedsDue(current as unknown as ProviderAgentSeedRow).length > 0
    && deps.now().getTime() + SEED_BUDGET_MS <= options.deadline) {
    try {
      if (await claimSeedAttempt(userId, current, deps.now()) === "claimed") {
        const { attempted, confirmed } = await deps.seed(userId, current as unknown as ProviderAgentSeedRow);
        const at = deps.now().toISOString();
        for (const part of confirmed) {
          const column = SEED_COLUMN[part];
          const { data: updated } = await supabaseAdmin.from("hivra_agents").update({ [column]: at })
            .eq("id", agentId).eq("user_id", userId).is(column, null).select().maybeSingle();
          if (updated) current = updated as UpkeepRow;
          await logHivraAgentEvent({ userId, event: SEED_EVENT[part], agentId, agentType: String(current.type) });
        }
        if (attempted.length > confirmed.length) {
          log.warn("provider agent seed not confirmed; retrying later", {
            source: LOG_SOURCE, failureType: "provider_agent_seed_unconfirmed", userId, agentId,
            detail: { unconfirmed: attempted.filter((part) => !confirmed.includes(part)) },
          });
        }
      }
    } catch (seedError) {
      log.warn("provider agent seed step skipped", {
        source: LOG_SOURCE, failureType: "provider_agent_seed_skipped", userId, agentId,
        errorMessage: seedError instanceof Error ? seedError.message : String(seedError),
      });
    }
  }

  // The bootstrap seed rewrites system-prompt.md, where the contract block
  // lives. Until the computer confirms it, another page load may be running
  // it right now, and a contract written in between would be lost while its
  // row says Delivered. The contract waits for the confirmed bootstrap.
  const bootstrapDue = providerAgentSeedsDue(current as unknown as ProviderAgentSeedRow).includes("bootstrap");
  const plan = computerContractPlanFor(current as unknown as ComputerContractSubject);
  if (!bootstrapDue && current.ip && plan.status === "deliverable" && plan.channel === "provider-seed") {
    await deps.contract(userId, current, "auto", { deadline: options.deadline, now: deps.now });
  }
}
