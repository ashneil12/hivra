// Connect a Hermes agent to the user's own Bankr account (POST) or remove
// Hivra's copy of that key (DELETE). This is how every new agent wallet is
// set up: Hivra no longer creates wallets for agents. See
// connectUserBankrWalletForOwner for what is stored and checked.
//
// Delivery to the running agent depends on its backend. A "webfree" box
// (gateway/webui) takes BANKR_* only from its persisted runtime env, which only
// a runtime update rewrites. That update restarts the agent for 1-3 minutes and
// stops chats in progress, so it runs only when the user asks for it with
// `restartAgent: true` (POST body, or an optional JSON body on DELETE), through
// applyBankrWalletChangeToWebfreeInstance. Otherwise the change reaches the box
// at its next runtime update and the response says so (configSync "skipped",
// configSyncReason "restart_not_requested"). Other boxes get their config
// rewritten through the agent's config API either way.

import type { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import {
  loadOwnedHermesInstance,
  syncBankrConfigToRunningHermesInstance,
} from "@/lib/agent-wallets/hermes-lane";
import {
  applyBankrWalletChangeToWebfreeInstance,
  type WebfreeWalletRuntimeSkipReason,
} from "@/lib/agent-wallets/hermes-webfree-wallet-sync";
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
import { isWebfreeBackend } from "@/lib/types/instance";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// A webfree box's runtime update is launched in-request: the Proxmox launch
// alone can take up to 90s. Declare the duration explicitly, matching the
// other long-running instance routes, so the route is never cut off after
// the wallet change has committed.
export const maxDuration = 300;

const LOG_SOURCE = "bankr-instance-wallet-connect-route";
const FAILURE_PREFIX = "agent_wallet_connect";

type ConfigSync = "synced" | "skipped" | "failed" | "update_started";
/** Why a webfree box didn't get the change now: the user didn't ask for the restart, or the update was skipped. */
type ConfigSyncSkipReason = WebfreeWalletRuntimeSkipReason | "restart_not_requested";
type RuntimeDelivery = { configSync: ConfigSync; configSyncReason?: ConfigSyncSkipReason };

// Only `true` restarts a webfree agent; absent or false leaves it running.
const restartAgentBodySchema = z.object({ restartAgent: z.boolean().optional() });

/**
 * Read the optional `restartAgent` flag. A missing, empty or non-JSON body
 * (older clients send DELETE with none) means "don't restart"; a flag that
 * isn't a boolean is refused.
 */
async function readRestartAgent(
  req: Request
): Promise<{ ok: true; restartAgent: boolean } | { ok: false; response: Response }> {
  const json = await req.json().catch(() => null);
  const parsed = restartAgentBodySchema.safeParse(json ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      response: apiError("restartAgent must be true or false.", 400, {
        failureType: "agent_wallet_connect_invalid_restart_agent",
      }),
    };
  }
  return { ok: true, restartAgent: parsed.data.restartAgent === true };
}

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

/**
 * Deliver the committed wallet change to a webfree box: through a runtime
 * update of that box when the user asked for the restart, otherwise at its
 * next runtime update.
 */
async function deliverToWebfreeBox(
  instanceId: string,
  userId: string,
  failurePrefix: string,
  restartAgent: boolean
): Promise<RuntimeDelivery> {
  if (!restartAgent) {
    log.info("agent wallet runtime update not requested", {
      source: LOG_SOURCE,
      instanceId,
      userId,
      failureType: `${failurePrefix}_runtime_update_not_requested`,
    });
    return { configSync: "skipped", configSyncReason: "restart_not_requested" };
  }
  const runtime = await applyBankrWalletChangeToWebfreeInstance({ instanceId, userId });
  if (runtime.status === "update_started") return { configSync: "update_started" };
  if (runtime.status === "skipped") return { configSync: "skipped", configSyncReason: runtime.reason };
  log.warn("agent wallet runtime update failed after connect change", {
    source: LOG_SOURCE,
    instanceId,
    failureType: `${failurePrefix}_runtime_update_failed`,
  });
  return { configSync: "failed" };
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

    // parseConnectBody consumes the body, so the restart flag is read from a copy.
    const restartBody = req.clone();
    const parsed = await parseConnectBody(req);
    if (!parsed.ok) return parsed.response;
    const restart = await readRestartAgent(restartBody);
    if (!restart.ok) return restart.response;

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

    // Webfree boxes skip the config API: their key arrives with a runtime
    // update, now if the user asked for the restart, otherwise at the next one.
    const webfree = isWebfreeBackend(instance.backend);
    const configSync = webfree ? null : await syncConfig(instance, userId);
    let bankrSuite = { seeded: record.metadata.bankrSuiteSeeded === true, count: 0 };
    if (!bankrSuite.seeded) {
      // Before a webfree update: the skill install needs the live agent API,
      // which the update's container recreate interrupts.
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
    const delivery: RuntimeDelivery = configSync
      ? { configSync }
      : await deliverToWebfreeBox(id, userId, FAILURE_PREFIX, restart.restartAgent);

    return apiSuccess({
      wallet: instanceBankrWalletPublicSummary(record),
      replacedProvisionedWallet,
      oldKeysRevoked,
      ...delivery,
      bankrSuite,
    });
  } catch (err) {
    return connectErrorResponse(err, FAILURE_PREFIX) ?? handleApiError(err);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const identity = await resolveWalletRouteIdentity(ctx);
    if (!identity.ok) return identity.response;
    const { id, userId } = identity;

    // A disconnect on a webfree box can start a runtime update, so it is
    // rate limited like connect.
    const limited = enforceConnectRateLimit(req, userId, "agent_wallet_disconnect");
    if (limited) return limited;

    const instance = await loadOwnedHermesInstance(id, userId);
    if (!instance) return apiError("Instance not found", 404);

    const restart = await readRestartAgent(req);
    if (!restart.ok) return restart.response;

    const record = await disconnectUserBankrWalletForOwner({ owner: { instanceId: id }, userId });
    log.info("agent wallet disconnected from user-owned Bankr account", {
      source: LOG_SOURCE,
      instanceId: id,
      userId,
    });
    // Only after the disconnect has committed: the update re-reads the row
    // and clears the key only when it finds it revoked.
    const delivery: RuntimeDelivery = isWebfreeBackend(instance.backend)
      ? await deliverToWebfreeBox(id, userId, "agent_wallet_disconnect", restart.restartAgent)
      : { configSync: await syncConfig(instance, userId) };

    return apiSuccess({ wallet: instanceBankrWalletPublicSummary(record), ...delivery });
  } catch (err) {
    return connectErrorResponse(err, "agent_wallet_disconnect") ?? handleApiError(err);
  }
}
