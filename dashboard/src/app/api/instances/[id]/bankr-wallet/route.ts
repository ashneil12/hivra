import type { NextRequest } from "next/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import {
  getBankrWalletForInstance,
  instanceBankrWalletPublicSummary,
  listWithdrawalRecipientsForInstance,
  provisionBankrWalletForInstance,
  readInstanceBankrWalletBalances,
} from "@/lib/billing/bankr-instance-wallets";
import {
  loadOwnedHermesInstance,
  syncBankrConfigToRunningHermesInstance,
} from "@/lib/agent-wallets/hermes-lane";
import { resolveWalletRouteIdentity } from "@/lib/billing/bankr-wallet-route-shared";
import { log } from "@/lib/logger";
import { getRequestContext } from "@/lib/request-context";
import { preinstallBankrSuiteForInstance } from "@/lib/services/instance-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const LOG_SOURCE = "bankr-instance-wallet-route";
const ROUTE_PATTERN = "/api/instances/[id]/bankr-wallet";
const BALANCE_RPC_FAILURE_TYPE = "bankr_instance_wallet_balance_rpc_failed";
const CONNECT_REQUIRED_MESSAGE =
  "New agent wallets connect to your own Bankr account. Use Connect Bankr account instead.";
const BALANCE_UNAVAILABLE_MESSAGE =
  "Balance temporarily unavailable. Your wallet address is still usable; retry the balance check shortly.";

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function classifyWalletBalanceError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/RpcResponse\.InternalError|internal error/i.test(message)) return "rpc_internal_error";
  if (/timeout|timed out|AbortError/i.test(message)) return "rpc_timeout";
  if (/invalid|malformed|json/i.test(message)) return "rpc_malformed_response";
  return "rpc_balance_read_failed";
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestContext = await getRequestContext(req as NextRequest, {
    source: LOG_SOURCE,
    route: ROUTE_PATTERN,
    skipAuth: true,
  });
  try {
    const identity = await resolveWalletRouteIdentity(ctx);
    if (!identity.ok) return identity.response;
    const { id, userId } = identity;

    const instance = await loadOwnedHermesInstance(id, userId);
    if (!instance) return apiError("Instance not found", 404);

    const record = await getBankrWalletForInstance({ instanceId: id });
    const summary = instanceBankrWalletPublicSummary(record);
    let balances: Awaited<ReturnType<typeof readInstanceBankrWalletBalances>> | null = null;
    let balanceError: null | {
      failureType: string;
      retryable: true;
      requestId: string;
      message: string;
    } = null;
    if (record?.status === "active") {
      try {
        balances = await readInstanceBankrWalletBalances({ walletAddress: record.evmAddress });
      } catch (err) {
        log.warn("bankr instance wallet balance RPC failed", {
          source: LOG_SOURCE,
          requestId: requestContext.requestId,
          route: requestContext.route,
          method: requestContext.method,
          instanceId: id,
          userId,
          walletStatus: record.status,
          failureType: BALANCE_RPC_FAILURE_TYPE,
          errorName: err instanceof Error ? err.name : null,
          errorClass: classifyWalletBalanceError(err),
        });
        balanceError = {
          failureType: BALANCE_RPC_FAILURE_TYPE,
          retryable: true,
          requestId: requestContext.requestId,
          message: BALANCE_UNAVAILABLE_MESSAGE,
        };
      }
    }
    const balance = balances?.find((entry) => entry.tokenSymbol === "ETH") ?? null;
    const withdrawalRecipients = record?.status === "active"
      ? await listWithdrawalRecipientsForInstance({ instanceId: id, userId }).catch((err) => {
          log.warn("bankr instance wallet recipient history load failed", {
            source: LOG_SOURCE,
            instanceId: id,
            userId,
            failureType: "bankr_instance_wallet_recipients_load_failed",
            errorName: err instanceof Error ? err.name : null,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          return [];
        })
      : [];

    return apiSuccess({ wallet: summary, balance, balances, balanceError, withdrawalRecipients }, 200, requestContext);
  } catch (err) {
    return handleApiError(err, requestContext);
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const identity = await resolveWalletRouteIdentity(ctx);
    if (!identity.ok) return identity.response;
    const { id, userId } = identity;

    const instance = await loadOwnedHermesInstance(id, userId);
    if (!instance) return apiError("Instance not found", 404);

    const result = await provisionBankrWalletForInstance({
      instanceId: id,
      userId,
    });
    if (result.status === "connect_required") {
      // Hivra no longer creates agent wallets. Only a wallet it already
      // created is kept working; everything else connects the user's own
      // Bankr account via POST ./connect.
      return apiError(CONNECT_REQUIRED_MESSAGE, 409, { failureType: "bankr_agent_wallet_connect_required" });
    }
    if (result.status === "pending" || result.status === "not_configured") {
      log.warn("bankr instance wallet provisioning still pending after dashboard retry", {
        source: LOG_SOURCE,
        instanceId: id,
        userId,
        provisionStatus: result.status,
        walletStatus: result.record?.status ?? null,
        apiKeyStatus: result.record?.apiKeyStatus ?? null,
        lastProvisionReason: readMetadataString(result.record?.metadata, "lastProvisionReason"),
        lastProvisionAttemptAt: readMetadataString(result.record?.metadata, "lastProvisionAttemptAt"),
        lastProvisionError: readMetadataString(result.record?.metadata, "lastProvisionError"),
        failureType: "bankr_instance_wallet_provision_pending",
      });
    }
    let configSync: "synced" | "skipped" | "failed" = "skipped";
    if (result.record?.status === "active") {
      try {
        configSync = await syncBankrConfigToRunningHermesInstance(instance, userId);
      } catch (err) {
        configSync = "failed";
        log.warn("bankr wallet provisioned but config sync failed", {
          source: LOG_SOURCE,
          instanceId: id,
          failureType: "bankr_instance_wallet_config_sync_failed",
          errorName: err instanceof Error ? err.name : null,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
    let bankrSuite = {
      seeded: result.record?.metadata.bankrSuiteSeeded === true,
      count: 0,
    };
    if (result.record?.metadata.bankrSuiteSeeded !== true) {
      try {
        const seedResult = await preinstallBankrSuiteForInstance({ instanceId: id, userId });
        bankrSuite = {
          seeded: seedResult.seeded,
          count: seedResult.count,
        };
      } catch (err) {
        log.warn("bankr suite preinstall failed after wallet provisioning", {
          source: LOG_SOURCE,
          instanceId: id,
          userId,
          failureType: "bankr_instance_wallet_suite_seed_failed",
          errorName: err instanceof Error ? err.name : null,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        bankrSuite = {
          seeded: false,
          count: 0,
        };
      }
    }

    return apiSuccess({
      status: result.status,
      wallet: instanceBankrWalletPublicSummary(result.record),
      configSync,
      bankrSuite,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
