// Connect a Hivra-catalog box (codex / claude-code) to the user's own Bankr
// account (POST) or remove Hivra's copy of that key (DELETE). The Hivra-lane
// analogue of /api/instances/[id]/bankr-wallet/connect: the key reaches the box
// as ~/.hivra/bankr.env over SSH, and a disconnect deletes that file.

import type { NextRequest } from "next/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import {
  loadOwnedHivraWalletAgent,
  syncBankrEnvToRunningHivraAgent,
  type OwnedHivraWalletAgent,
} from "@/lib/agent-wallets/hivra-lane";
import {
  connectErrorResponse,
  enforceConnectRateLimit,
  parseConnectBody,
} from "@/lib/agent-wallets/connect-route";
import {
  connectUserBankrWalletForOwner,
  disconnectUserBankrWalletForOwner,
  instanceBankrWalletPublicSummary,
  type InstanceBankrWalletRecord,
} from "@/lib/billing/bankr-instance-wallets";
import { resolveWalletRouteIdentity } from "@/lib/billing/bankr-wallet-route-shared";
import {
  describeHivraAgentExecutionContextError,
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import { bankrSkillsDirForType } from "@/lib/hivra/bankr-skills-seed";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

const LOG_SOURCE = "hivra-bankr-wallet-connect-route";
const FAILURE_PREFIX = "hivra_agent_wallet_connect";

type AgentGate =
  | { ok: true; agent: OwnedHivraWalletAgent; executionContext: HivraAgentExecutionContext | null }
  | { ok: false; response: Response };

async function loadAgentForWallet(id: string, userId: string): Promise<AgentGate> {
  const agent = await loadOwnedHivraWalletAgent(id, userId);
  if (!agent) return { ok: false, response: apiError("Agent not found", 404) };
  if (!bankrSkillsDirForType(agent.type)) {
    return { ok: false, response: apiError("Wallet not supported for this agent type", 400) };
  }
  // Resolve the SSH context before touching the wallet row, so an unreachable
  // box refuses the change instead of leaving the row and the box out of step.
  let executionContext: HivraAgentExecutionContext | null = null;
  if (agent.status === "running" && agent.ip) {
    try {
      executionContext = await resolveHivraAgentExecutionContext(userId, agent);
    } catch (contextError) {
      const safeError = describeHivraAgentExecutionContextError(contextError);
      if (safeError) return { ok: false, response: apiError(safeError.message, safeError.status) };
      throw contextError;
    }
  }
  return { ok: true, agent, executionContext };
}

async function syncEnv(
  gate: Extract<AgentGate, { ok: true }>,
  record: InstanceBankrWalletRecord
): Promise<"synced" | "skipped" | "failed"> {
  const sync = await syncBankrEnvToRunningHivraAgent({
    agent: gate.agent,
    record,
    executionContext: gate.executionContext,
  });
  if (sync.status === "failed") {
    log.warn("hivra agent wallet env sync failed after connect change", {
      source: LOG_SOURCE,
      agentId: gate.agent.id,
      failureType: `${FAILURE_PREFIX}_env_sync_failed`,
      error: sync.error,
    });
  }
  return sync.status;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const identity = await resolveWalletRouteIdentity(ctx);
    if (!identity.ok) return identity.response;
    const { id, userId } = identity;

    const limited = enforceConnectRateLimit(req, userId, "hivra_agent_wallet_connect");
    if (limited) return limited;

    const gate = await loadAgentForWallet(id, userId);
    if (!gate.ok) return gate.response;

    const parsed = await parseConnectBody(req);
    if (!parsed.ok) return parsed.response;

    const { record, replacedProvisionedWallet, oldKeysRevoked } = await connectUserBankrWalletForOwner({
      owner: { hivraAgentId: id },
      userId,
      apiKey: parsed.body.apiKey,
      replaceProvisionedWallet: parsed.body.replaceProvisionedWallet,
    });
    log.info("hivra agent wallet connected to user-owned Bankr account", {
      source: LOG_SOURCE,
      agentId: id,
      agentType: gate.agent.type,
      userId,
      replacedProvisionedWallet,
    });
    if (oldKeysRevoked === false) {
      // The user's funds are safe (the old wallet was empty), but the old
      // Hivra key may still work at Bankr until someone revokes it there.
      log.error("replaced agent wallet keys were not revoked at Bankr", new Error("bankr key revocation failed"), {
        source: LOG_SOURCE,
        agentId: id,
        userId,
        failureType: `${FAILURE_PREFIX}_old_keys_not_revoked`,
      });
    }
    const envSync = await syncEnv(gate, record);

    return apiSuccess({
      wallet: instanceBankrWalletPublicSummary(record),
      replacedProvisionedWallet,
      oldKeysRevoked,
      envSync,
    });
  } catch (err) {
    return connectErrorResponse(err, FAILURE_PREFIX) ?? handleApiError(err);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const identity = await resolveWalletRouteIdentity(ctx);
    if (!identity.ok) return identity.response;
    const { id, userId } = identity;

    const gate = await loadAgentForWallet(id, userId);
    if (!gate.ok) return gate.response;

    const record = await disconnectUserBankrWalletForOwner({ owner: { hivraAgentId: id }, userId });
    log.info("hivra agent wallet disconnected from user-owned Bankr account", {
      source: LOG_SOURCE,
      agentId: id,
      agentType: gate.agent.type,
      userId,
    });
    const envSync = await syncEnv(gate, record);

    return apiSuccess({ wallet: instanceBankrWalletPublicSummary(record), envSync });
  } catch (err) {
    return connectErrorResponse(err, "hivra_agent_wallet_disconnect") ?? handleApiError(err);
  }
}
