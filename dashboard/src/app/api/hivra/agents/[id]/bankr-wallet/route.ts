// Per-box Bankr wallet for a Hivra-catalog CLI agent (codex / claude-code).
// The Hivra-lane analogue of /api/instances/[id]/bankr-wallet: same wallet table
// + provisioning code (keyed by hivra_agent_id instead of instance_id), but the
// creds are delivered to the box over SSH as ~/.hivra/bankr.env rather than baked
// into an agent YAML. POST only keeps a wallet Hivra already created working;
// new agent wallets connect the user's own Bankr account via ./connect.

import type { NextRequest } from "next/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import {
  loadOwnedHivraWalletAgent,
  syncBankrEnvToRunningHivraAgent,
} from "@/lib/agent-wallets/hivra-lane";
import {
  getBankrWalletForHivraAgent,
  instanceBankrWalletPublicSummary,
  provisionBankrWalletForHivraAgent,
  readInstanceBankrWalletBalances,
} from "@/lib/billing/bankr-instance-wallets";
import { resolveWalletRouteIdentity } from "@/lib/billing/bankr-wallet-route-shared";
import { bankrSkillsDirForType } from "@/lib/hivra/bankr-skills-seed";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { log } from "@/lib/logger";
import {
  describeHivraAgentExecutionContextError,
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

const LOG_SOURCE = "hivra-bankr-wallet-route";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const identity = await resolveWalletRouteIdentity(ctx);
    if (!identity.ok) return identity.response;
    const { id, userId } = identity;

    const agent = await loadOwnedHivraWalletAgent(id, userId);
    if (!agent) return apiError("Agent not found", 404);
    if (!bankrSkillsDirForType(agent.type)) return apiError("Wallet not supported for this agent type", 400);

    const record = await getBankrWalletForHivraAgent({ hivraAgentId: id });
    const summary = instanceBankrWalletPublicSummary(record);
    let balance: Awaited<ReturnType<typeof readInstanceBankrWalletBalances>>[number] | null = null;
    let balances: Awaited<ReturnType<typeof readInstanceBankrWalletBalances>> | null = null;
    if (record?.status === "active") {
      try {
        balances = await readInstanceBankrWalletBalances({ walletAddress: record.evmAddress });
        balance = balances.find((b) => b.tokenSymbol === "ETH") ?? null;
      } catch (err) {
        log.warn("hivra bankr wallet balance read failed", {
          source: LOG_SOURCE,
          agentId: id,
          failureType: "hivra_bankr_balance_failed",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return apiSuccess({ wallet: summary, balance, balances });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const identity = await resolveWalletRouteIdentity(ctx);
    if (!identity.ok) return identity.response;
    const { id, userId } = identity;

    const agent = await loadOwnedHivraWalletAgent(id, userId);
    if (!agent) return apiError("Agent not found", 404);
    if (!bankrSkillsDirForType(agent.type)) return apiError("Wallet not supported for this agent type", 400);

    let executionContext: HivraAgentExecutionContext | null = null;
    if (agent.status === "running" && agent.ip) {
      try {
        executionContext = await resolveHivraAgentExecutionContext(userId, agent);
      } catch (contextError) {
        const safeError = describeHivraAgentExecutionContextError(contextError);
        if (safeError) return apiError(safeError.message, safeError.status);
        throw contextError;
      }
    }

    const result = await provisionBankrWalletForHivraAgent({ hivraAgentId: id, userId });
    if (result.status === "connect_required") {
      // Hivra no longer creates agent wallets. Only a wallet it already
      // created is kept working; everything else connects the user's own
      // Bankr account via POST ./connect.
      return apiError(
        "New agent wallets connect to your own Bankr account. Use Connect Bankr account instead.",
        409,
        { failureType: "hivra_bankr_wallet_connect_required" },
      );
    }

    // When the wallet is live, push the creds onto the running box so the agent
    // CLI can sign with it. Best-effort: the wallet row is already persisted, so a
    // failed env-sync is retryable (POST again) and never loses the wallet.
    let envSync: "synced" | "skipped" | "failed" = "skipped";
    if (result.record?.status === "active") {
      const sync = await syncBankrEnvToRunningHivraAgent({ agent, record: result.record, executionContext });
      envSync = sync.status;
      if (sync.status === "failed") {
        log.warn("hivra bankr wallet env seed failed", {
          source: LOG_SOURCE,
          agentId: id,
          failureType: "hivra_bankr_env_seed_failed",
          error: sync.error,
        });
      }
      await logHivraAgentEvent({
        userId,
        event: "bankr_wallet_provisioned",
        agentId: id,
        agentType: agent.type,
        detail: { status: result.status, envSync },
      });
    }

    return apiSuccess({
      status: result.status,
      wallet: instanceBankrWalletPublicSummary(result.record),
      envSync,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
