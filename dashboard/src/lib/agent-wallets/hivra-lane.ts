// Hivra-lane plumbing shared by /api/hivra/agents/[id]/bankr-wallet and its
// ./connect route. A Hivra box gets its wallet key as ~/.hivra/bankr.env over
// SSH; the file is written for an active wallet row and deleted otherwise.

import {
  buildInstanceBankrAgentConfig,
  type InstanceBankrWalletRecord,
} from "@/lib/billing/bankr-instance-wallets";
import type { HivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { removeBankrWalletEnvFromBox, seedBankrWalletEnvOntoBox } from "@/lib/hivra/bankr-wallet-env-seed";
import { supabaseAdmin } from "@/lib/supabase";

export interface OwnedHivraWalletAgent {
  id: string;
  user_id: string;
  type: string;
  status: string;
  ip: string | null;
  proxmox_host: string | null;
  infrastructure_connection_id: string | null;
  deployment_target_id: string | null;
  infrastructure_connection_revision: number | null;
}

export async function loadOwnedHivraWalletAgent(id: string, userId: string): Promise<OwnedHivraWalletAgent | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from("hivra_agents")
    .select("id,user_id,type,status,ip,proxmox_host,infrastructure_connection_id,deployment_target_id,infrastructure_connection_revision")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as OwnedHivraWalletAgent | null) || null;
}

export type HivraWalletEnvSync =
  | { status: "synced" | "skipped" }
  | { status: "failed"; error: string };

/**
 * Make a running Hivra box's ~/.hivra/bankr.env match the wallet row: write it
 * for an active row with a key, delete it otherwise. Skipped when the box
 * isn't running (the next seed or launch reads the row).
 */
export async function syncBankrEnvToRunningHivraAgent(params: {
  agent: OwnedHivraWalletAgent;
  record: InstanceBankrWalletRecord | null;
  executionContext: HivraAgentExecutionContext | null;
}): Promise<HivraWalletEnvSync> {
  const { agent, record, executionContext } = params;
  if (agent.status !== "running" || !agent.ip) return { status: "skipped" };
  if (!executionContext) {
    return { status: "failed", error: "Agent execution context was not resolved for wallet sync" };
  }

  const cfg = record?.status === "active" ? await buildInstanceBankrAgentConfig(record) : null;
  const seedAgent = { id: agent.id, type: agent.type, ip: agent.ip };
  const result = cfg
    ? await seedBankrWalletEnvOntoBox(seedAgent, cfg, executionContext.env)
    : await removeBankrWalletEnvFromBox(seedAgent, executionContext.env);
  if (result.ok) return { status: "synced" };
  return { status: "failed", error: result.error ?? result.skipped ?? "wallet env sync failed" };
}
