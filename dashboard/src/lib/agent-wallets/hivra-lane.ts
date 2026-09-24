// Hivra-lane plumbing shared by /api/hivra/agents/[id]/bankr-wallet and its
// ./connect route. A Hivra box gets its wallet key as ~/.hivra/bankr.env over
// VMID-pinned SSH; the file is written for an active wallet row and deleted
// otherwise.

import {
  agentWalletCustody,
  buildInstanceBankrAgentConfig,
  getBankrWalletForHivraAgent,
  type InstanceBankrWalletRecord,
} from "@/lib/billing/bankr-instance-wallets";
import {
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
  type HivraAgentInfrastructureBinding,
} from "@/lib/hivra/agent-execution-context";
import { bankrSkillsDirForType } from "@/lib/hivra/bankr-skills-seed";
import { removeBankrWalletEnvFromBox, seedBankrWalletEnvOntoBox } from "@/lib/hivra/bankr-wallet-env-seed";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "hivra-agent-wallet-boot-sync";

// Every column resolveHivraAgentExecutionContext reads. Selecting fewer makes
// the resolver see an unbound agent and refuse with "invalid infrastructure
// binding", which is how wallet delivery broke once binding tokens, channels
// and substrates were added.
export const HIVRA_WALLET_AGENT_COLUMNS = [
  "id",
  "user_id",
  "type",
  "status",
  "ip",
  "vmid",
  "proxmox_host",
  "deployment_mode",
  "managed_provisioner_channel",
  "computer_substrate",
  "infrastructure_connection_id",
  "deployment_target_id",
  "infrastructure_connection_revision",
  "infrastructure_binding_token_hash",
  "infrastructure_binding_token_enforced",
  "provider_capacity_order_id",
  "provider_enrollment_attempt_id",
  "provider_server_id",
] as const satisfies readonly (keyof OwnedHivraWalletAgent)[];

// Compile-time guard: adding a field to HivraAgentInfrastructureBinding without
// selecting it here fails the build instead of breaking wallets at runtime.
type UnselectedBindingColumn = Exclude<
  keyof HivraAgentInfrastructureBinding,
  (typeof HIVRA_WALLET_AGENT_COLUMNS)[number]
>;
const everyBindingColumnSelected: [UnselectedBindingColumn] extends [never] ? true : never = true;
void everyBindingColumnSelected;

export interface OwnedHivraWalletAgent extends HivraAgentInfrastructureBinding {
  id: string;
  user_id: string;
  type: string;
  status: string;
  ip: string | null;
  vmid: number | null;
  proxmox_host: string | null;
  infrastructure_connection_id: string | null;
  deployment_target_id: string | null;
  infrastructure_connection_revision: number | null;
}

export async function loadOwnedHivraWalletAgent(id: string, userId: string): Promise<OwnedHivraWalletAgent | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from("hivra_agents")
    .select(HIVRA_WALLET_AGENT_COLUMNS.join(","))
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as unknown as OwnedHivraWalletAgent | null) || null;
}

export type HivraWalletEnvSync =
  | { status: "synced" | "skipped" }
  | { status: "failed"; error: string; reason?: "identity_unverifiable" };

/** The agent fields a wallet env sync reads. vmid pins SSH to the exact VM. */
type HivraWalletEnvAgent = Pick<OwnedHivraWalletAgent, "id" | "status" | "ip" | "vmid"> & { type: string | null };

/**
 * Whether a box's row carries what the pinned SSH path needs: a VMID and an
 * enforced owner binding. Older boxes without them never receive or lose a
 * wallet key (bankr-wallet-env-seed.ts fails closed on them).
 */
export function isPinnableHivraWalletBox(agent: {
  vmid?: unknown;
  infrastructure_binding_token_enforced?: unknown;
}): boolean {
  const vmid = Number(agent.vmid ?? NaN);
  return Number.isSafeInteger(vmid) && vmid >= 100 && agent.infrastructure_binding_token_enforced === true;
}

/**
 * Make a running Hivra box's ~/.hivra/bankr.env match the wallet row: write it
 * for an active row with a key, delete it otherwise. Skipped when the box
 * isn't running; reconcileBankrEnvAfterHivraBoot applies the row when it
 * comes up. Fails without touching the box when it can't be pinned to its
 * VMID (no vmid, no enforced owner binding tag, no guest SSH key).
 */
export async function syncBankrEnvToRunningHivraAgent(params: {
  agent: HivraWalletEnvAgent;
  record: InstanceBankrWalletRecord | null;
  executionContext: HivraAgentExecutionContext | null;
}): Promise<HivraWalletEnvSync> {
  const { agent, record, executionContext } = params;
  if (agent.status !== "running" || !agent.ip) return { status: "skipped" };
  if (!executionContext) {
    return { status: "failed", error: "Agent execution context was not resolved for wallet sync" };
  }

  const cfg = record?.status === "active" ? await buildInstanceBankrAgentConfig(record) : null;
  const seedAgent = { id: agent.id, type: agent.type, ip: agent.ip, vmid: agent.vmid };
  const result = cfg
    ? await seedBankrWalletEnvOntoBox(seedAgent, cfg, executionContext)
    : await removeBankrWalletEnvFromBox(seedAgent, executionContext);
  if (result.ok) return { status: "synced" };
  return {
    status: "failed",
    error: result.error ?? result.skipped ?? "wallet env sync failed",
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

export type HivraBootWalletAgent = HivraWalletEnvAgent & HivraAgentInfrastructureBinding;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Apply the wallet row to a Hivra box that just came (back) up: start,
 * restart, resize, update_runtime, and the first start after a snapshot
 * restore (restore itself always ends stopped). A connect or disconnect made
 * while the box was stopped never reached its disk, and a restored snapshot can
 * carry an old bankr.env, so this runs on every boot, not only when the row
 * changed.
 *
 * Only rows holding a key from the user's own Bankr account are touched;
 * Hivra-provisioned wallets keep their existing delivery. Never throws and
 * never deletes on a key-decryption error, so it can't fail a lifecycle action
 * or wipe a live wallet over a misconfiguration.
 */
export async function reconcileBankrEnvAfterHivraBoot(params: {
  userId: string;
  agent: HivraBootWalletAgent;
  /** The caller's lifecycle context; resolved here when absent. */
  executionContext?: HivraAgentExecutionContext | null;
  trigger: "poll" | "recovery";
}): Promise<HivraWalletEnvSync> {
  const { userId, agent, trigger } = params;
  if (!bankrSkillsDirForType(agent.type) || agent.status !== "running" || !agent.ip?.trim()) {
    return { status: "skipped" };
  }

  const eligible = (row: InstanceBankrWalletRecord | null): row is InstanceBankrWalletRecord =>
    Boolean(row && row.userId === userId && agentWalletCustody(row) === "user_connected");
  const fail = (error: string, action: "write" | "remove" | null): HivraWalletEnvSync => {
    log.warn("hivra agent wallet env sync failed after boot", {
      source: LOG_SOURCE,
      agentId: agent.id,
      trigger,
      action,
      failureType: "hivra_agent_wallet_boot_env_sync_failed",
      error,
    });
    return { status: "failed", error };
  };

  let record: InstanceBankrWalletRecord | null;
  try {
    record = await getBankrWalletForHivraAgent({ hivraAgentId: agent.id });
  } catch (error) {
    return fail(errorMessage(error), null);
  }
  if (!eligible(record)) return { status: "skipped" };

  let executionContext = params.executionContext ?? null;
  if (!executionContext) {
    try {
      executionContext = await resolveHivraAgentExecutionContext(userId, agent);
    } catch (error) {
      return fail(errorMessage(error), null);
    }
  }

  const sync = async (row: InstanceBankrWalletRecord): Promise<HivraWalletEnvSync> => {
    const action = row.status === "active" && row.apiKeyStatus === "active" ? "write" : "remove";
    let result: HivraWalletEnvSync;
    try {
      result = await syncBankrEnvToRunningHivraAgent({ agent, record: row, executionContext });
    } catch (error) {
      // buildInstanceBankrAgentConfig throws before any SSH, so a decryption
      // failure leaves the box's file as it was.
      return fail(errorMessage(error), action);
    }
    if (result.status === "failed") return fail(result.error, action);
    if (result.status === "synced") {
      log.info("hivra agent wallet env applied after boot", { source: LOG_SOURCE, agentId: agent.id, trigger, action });
    }
    return result;
  };

  const first = await sync(record);
  // A connect or disconnect that landed while the file was being written
  // would otherwise be overwritten by the older row. Once the box is running,
  // any later change syncs through its own route.
  let fresh: InstanceBankrWalletRecord | null;
  try {
    fresh = await getBankrWalletForHivraAgent({ hivraAgentId: agent.id });
  } catch {
    return first;
  }
  if (!eligible(fresh) || fresh.updatedAt === record.updatedAt) return first;
  return sync(fresh);
}
