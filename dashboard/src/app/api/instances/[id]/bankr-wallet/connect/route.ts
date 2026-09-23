// Connect a Hermes agent to the user's own Bankr account (POST) or remove
// Hivra's copy of that key (DELETE). This is how every new agent wallet is
// set up: Hivra no longer creates wallets for agents. See
// connectUserBankrWalletForOwner for what is stored and checked.

import type { NextRequest } from "next/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import {
  loadOwnedHermesInstance,
  syncBankrConfigToRunningHermesInstance,
} from "@/lib/agent-wallets/hermes-lane";
import {
  connectErrorResponse,
  enforceConnectRateLimit,
  parseConnectBody,
} from "@/lib/agent-wallets/connect-route";
import {
  connectUserBankrWalletForOwner,
  disconnectUserBankrWalletForOwner,
  instanceBankrWalletPublicSummary,
} from "@/lib/billing/bankr-instance-wallets";
import { resolveWalletRouteIdentity } from "@/lib/billing/bankr-wallet-route-shared";
import { log } from "@/lib/logger";
import { preinstallBankrSuiteForInstance } from "@/lib/services/instance-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const LOG_SOURCE = "bankr-instance-wallet-connect-route";
const FAILURE_PREFIX = "agent_wallet_connect";

async function syncConfig(
  instance: NonNullable<Awaited<ReturnType<typeof loadOwnedHermesInstance>>>,
  userId: string
): Promise<"synced" | "skipped" | "failed"> {
  try {
    return await syncBankrConfigToRunningHermesInstance(instance, userId);
  } catch (err) {
    log.warn("agent wallet config sync failed after connect change", {
      source: LOG_SOURCE,
      instanceId: instance.id,
      failureType: `${FAILURE_PREFIX}_config_sync_failed`,
      errorName: err instanceof Error ? err.name : null,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const identity = await resolveWalletRouteIdentity(ctx);
    if (!identity.ok) return identity.response;
    const { id, userId } = identity;

    const limited = enforceConnectRateLimit(req, userId, "agent_wallet_connect");
    if (limited) return limited;

    const instance = await loadOwnedHermesInstance(id, userId);
    if (!instance) return apiError("Instance not found", 404);

    const parsed = await parseConnectBody(req);
    if (!parsed.ok) return parsed.response;

    const { record, replacedProvisionedWallet, oldKeysRevoked } = await connectUserBankrWalletForOwner({
      owner: { instanceId: id },
      userId,
      apiKey: parsed.body.apiKey,
      replaceProvisionedWallet: parsed.body.replaceProvisionedWallet,
    });
    log.info("agent wallet connected to user-owned Bankr account", {
      source: LOG_SOURCE,
      instanceId: id,
      userId,
      replacedProvisionedWallet,
    });
    if (oldKeysRevoked === false) {
      // The user's funds are safe (the old wallet was empty), but the old
      // Hivra key may still work at Bankr until someone revokes it there.
      log.error("replaced agent wallet keys were not revoked at Bankr", new Error("bankr key revocation failed"), {
        source: LOG_SOURCE,
        instanceId: id,
        userId,
        failureType: `${FAILURE_PREFIX}_old_keys_not_revoked`,
      });
    }

    const configSync = await syncConfig(instance, userId);
    let bankrSuite = { seeded: record.metadata.bankrSuiteSeeded === true, count: 0 };
    if (!bankrSuite.seeded) {
      try {
        bankrSuite = await preinstallBankrSuiteForInstance({ instanceId: id, userId });
      } catch (err) {
        log.warn("bankr suite preinstall failed after wallet connect", {
          source: LOG_SOURCE,
          instanceId: id,
          failureType: `${FAILURE_PREFIX}_suite_seed_failed`,
          errorName: err instanceof Error ? err.name : null,
        });
      }
    }

    return apiSuccess({
      wallet: instanceBankrWalletPublicSummary(record),
      replacedProvisionedWallet,
      oldKeysRevoked,
      configSync,
      bankrSuite,
    });
  } catch (err) {
    return connectErrorResponse(err, FAILURE_PREFIX) ?? handleApiError(err);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const identity = await resolveWalletRouteIdentity(ctx);
    if (!identity.ok) return identity.response;
    const { id, userId } = identity;

    const instance = await loadOwnedHermesInstance(id, userId);
    if (!instance) return apiError("Instance not found", 404);

    const record = await disconnectUserBankrWalletForOwner({ owner: { instanceId: id }, userId });
    log.info("agent wallet disconnected from user-owned Bankr account", {
      source: LOG_SOURCE,
      instanceId: id,
      userId,
    });
    const configSync = await syncConfig(instance, userId);

    return apiSuccess({ wallet: instanceBankrWalletPublicSummary(record), configSync });
  } catch (err) {
    return connectErrorResponse(err, "agent_wallet_disconnect") ?? handleApiError(err);
  }
}
