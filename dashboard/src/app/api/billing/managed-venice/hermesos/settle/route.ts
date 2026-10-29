import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import {
  loadManagedVeniceTokenQuote,
  settleManagedVeniceTokenQuote,
} from "@/lib/billing/managed-venice-token-quotes";
import {
  resolveManagedVeniceTokenTransferLog,
  type ManagedVeniceTokenTransferLogResolution,
} from "@/lib/billing/managed-venice-token-reconciliation";
import { log } from "@/lib/logger";
import { createBaseChainReader } from "@/lib/billing/base-transfer-scan";

// observedAt and blockTimestamp are still accepted so existing callers keep
// working, but the transfer's time is read from the chain (see
// readTransferBlockTimestamp) and the caller's values are ignored.
const SettlementRequestSchema = z.object({
  quoteId: z.string().trim().min(1),
  transactionHash: z.string().trim().min(1),
  tokenAmountRaw: z.string().regex(/^[1-9]\d*$/),
  observedAt: z.string().trim().min(1),
  blockTimestamp: z.string().trim().min(1).optional(),
});

const ROUTE = "/api/billing/managed-venice/hermesos/settle";
const RETRY_AFTER_SECONDS = 60;

// A delivery that cannot be resolved to exactly one Transfer log (no receipt
// yet, a reverted tx, no or several logs carrying the delivered amount, or the
// Base RPC failing): nothing is written, and the caller retries. The
// reconciler attributes the tx from its own scan meanwhile. An unresolvable
// chain state is expected control flow (warn); an RPC failure is an error.
function retryLater(
  reason: string,
  metadata: Record<string, unknown>,
  options: { cause?: unknown; logLevel?: "warn" | "error" } = {}
) {
  const response = apiError(
    "Managed Venice settlement transfer could not be resolved; retry later.",
    503,
    { failureType: "managed_venice_settlement_transfer_unresolved", reason },
    { retryable: true, reason },
    {
      source: "managed-venice-token-settle",
      route: ROUTE,
      method: "POST",
      failureType: "managed_venice_settlement_transfer_unresolved",
      metadata: { reason, ...metadata },
      cause: options.cause,
      logLevel: options.logLevel ?? "warn",
    }
  );
  response.headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
  return response;
}

// The time a transfer happened is the block it was mined in, read from the
// chain. The quote window is decided by that time, so a caller-supplied time
// must never decide it: a late transfer claimed as in-window would be credited.
// Every log of a tx sits in the tx's one block, so the receipt gives the block.
// Returns an ISO timestamp; throws when the chain cannot answer.
async function readTransferBlockTimestamp(transactionHash: string): Promise<string> {
  const chain = createBaseChainReader({});
  const receipt = await chain.call<{ blockNumber?: unknown } | null>("eth_getTransactionReceipt", [
    transactionHash.trim().toLowerCase(),
  ]);
  if (!receipt || typeof receipt.blockNumber !== "string" || !/^0x[0-9a-fA-F]+$/.test(receipt.blockNumber)) {
    throw new Error("Invalid eth_getTransactionReceipt block number from Base RPC");
  }
  const blockTimestampSec = await chain.blockTimestamp(Number.parseInt(receipt.blockNumber, 16));
  return new Date(blockTimestampSec * 1000).toISOString();
}

function getSettlementSecret() {
  // CRON_SECRET is intentionally NOT a fallback here. This route mints wallet
  // credit by settling managed Venice token quotes — its bearer must be scoped
  // to the bankr reconciler, not every Vercel cron and operator debug script
  // that happens to know CRON_SECRET. Mirrors the crypto top-up settle route.
  return (
    process.env.MANAGED_VENICE_SETTLEMENT_SECRET?.trim() ||
    process.env.BILLING_SETTLEMENT_SECRET?.trim() ||
    null
  );
}

export async function POST(req: NextRequest) {
  const settlementSecret = getSettlementSecret();
  if (!settlementSecret) {
    log.error(
      "managed Venice settlement secret is not configured; refusing to run",
      new Error("missing settlement secret"),
      {
        source: "managed-venice-token-settle",
        route: ROUTE,
        method: "POST",
        failureType: "managed_venice_settlement_secret_missing",
      }
    );
    return apiError("Settlement secret is not configured.", 500);
  }

  if (!verifyBearerHeader(req, settlementSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      return apiError("Invalid JSON body.", 400, {
        failureType: "managed_venice_settlement_invalid_json",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }

    const parsed = SettlementRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid managed Venice settlement request.", 400, {
        failureType: "managed_venice_settlement_invalid_request",
      });
    }

    const quote = await loadManagedVeniceTokenQuote(parsed.data.quoteId);
    if (!quote) {
      return apiError("Managed Venice token quote not found.", 404, {
        failureType: "managed_venice_settlement_quote_not_found",
      });
    }

    // A delivery names a tx, and one tx can pay the deposit address several
    // times. Resolve it to its Transfer log (from the tx receipt) before
    // anything is keyed, bound or claimed, so it carries the same per-log
    // identity the reconciler gives that log.
    const delivery = {
      quoteId: quote.id,
      transactionHash: parsed.data.transactionHash,
      tokenAmountRaw: parsed.data.tokenAmountRaw,
    };
    let resolution: ManagedVeniceTokenTransferLogResolution;
    try {
      resolution = await resolveManagedVeniceTokenTransferLog({
        transactionHash: parsed.data.transactionHash,
        depositAddress: quote.depositAddress,
        tokenAmountRaw: parsed.data.tokenAmountRaw,
        tokenAddress: quote.tokenAddress,
      });
    } catch (error) {
      return retryLater("rpc_unavailable", delivery, { cause: error, logLevel: "error" });
    }
    if (resolution.status === "retryable") {
      return retryLater(resolution.reason, {
        ...delivery,
        ...(resolution.matchingLogIndexes ? { matchingLogIndexes: resolution.matchingLogIndexes } : {}),
      });
    }

    let transferTime: string;
    try {
      transferTime = await readTransferBlockTimestamp(parsed.data.transactionHash);
    } catch (error) {
      return retryLater("rpc_unavailable", delivery, { cause: error, logLevel: "error" });
    }

    const result = await settleManagedVeniceTokenQuote({
      quoteId: quote.id,
      transactionHash: parsed.data.transactionHash,
      tokenAmountRaw: parsed.data.tokenAmountRaw,
      // The quote window is checked against this time, so it is the transfer's
      // own block time from the chain, never the caller's claimed time.
      observedAt: transferTime,
      blockTimestamp: transferTime,
      logIndex: resolution.logIndex,
      dedupeLogIndex: resolution.dedupeLogIndex,
    });

    return apiSuccess(result);
  } catch (error) {
    return apiError(
      "Failed to settle managed Venice token quote.",
      500,
      {
        failureType: "managed_venice_settlement_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        source: "managed-venice-token-settle",
        route: ROUTE,
        method: "POST",
        failureType: "managed_venice_settlement_failed",
        cause: error,
      }
    );
  }
}
