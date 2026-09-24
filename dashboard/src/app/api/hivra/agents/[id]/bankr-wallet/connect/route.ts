// Connect a Hivra-catalog box (codex / claude-code) to the user's own Bankr
// account (POST) or remove Hivra's copy of that key (DELETE). The Hivra-lane
// analogue of /api/instances/[id]/bankr-wallet/connect: the key reaches the box
// as ~/.hivra/bankr.env over SSH, and a disconnect deletes that file.

import type { NextRequest } from "next/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import {
  isPinnableHivraWalletBox,
  loadOwnedHivraWalletAgent,
  syncBankrEnvToRunningHivraAgent,
  type HivraWalletEnvSync,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The gate only resolves a context for a box that was running when the request
 * began. A start that finished while the wallet row was being written may have
 * run its boot reconcile before the write and missed this change, so re-read
 * the box and sync to it if it is up now.
 */
async function syncEnvToBox(
  gate: Extract<AgentGate, { ok: true }>,
  userId: string,
  record: InstanceBankrWalletRecord
): Promise<HivraWalletEnvSync> {
  let { agent, executionContext } = gate;
  if (!executionContext) {
    const fresh = await loadOwnedHivraWalletAgent(agent.id, userId);
    if (!fresh || fresh.status !== "running" || !fresh.ip) {
      // A stopped box gets the change from its boot reconcile, but only if it
      // can be pinned to its VM then. Say so now instead of promising a
      // delivery that will fail closed at start.
      return isPinnableHivraWalletBox(fresh ?? agent)
        ? { status: "skipped" }
        : {
            status: "failed",
            reason: "identity_unverifiable",
            error: "this box can't be verified as its VM, so it won't receive wallet changes",
          };
    }
    agent = fresh;
    executionContext = await resolveHivraAgentExecutionContext(userId, fresh);
  }
  return syncBankrEnvToRunningHivraAgent({ agent, record, executionContext });
}

// Best effort: the wallet row is already written, so a sync failure is
// reported as envSync "failed" and never fails the response.
async function syncEnv(
  gate: Extract<AgentGate, { ok: true }>,
  userId: string,
  record: InstanceBankrWalletRecord
): Promise<{ envSync: "synced" | "skipped" | "failed"; envSyncReason?: "identity_unverifiable" }> {
  let sync: HivraWalletEnvSync;
  try {
    sync = await syncEnvToBox(gate, userId, record);
  } catch (error) {
    sync = { status: "failed", error: errorMessage(error) };
  }
  if (sync.status === "failed") {
    log.warn("hivra agent wallet env sync failed after connect change", {
      source: LOG_SOURCE,
      agentId: gate.agent.id,
      failureType: `${FAILURE_PREFIX}_env_sync_failed`,
      error: sync.error,
    });
  }
  return sync.status === "failed" && sync.reason
    ? { envSync: sync.status, envSyncReason: sync.reason }
    : { envSync: sync.status };
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
    const delivery = await syncEnv(gate, userId, record);

    return apiSuccess({
      wallet: instanceBankrWalletPublicSummary(record),
      replacedProvisionedWallet,
      oldKeysRevoked,
      ...delivery,
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
    const delivery = await syncEnv(gate, userId, record);

    return apiSuccess({ wallet: instanceBankrWalletPublicSummary(record), ...delivery });
  } catch (err) {
    return connectErrorResponse(err, "hivra_agent_wallet_disconnect") ?? handleApiError(err);
  }
}
