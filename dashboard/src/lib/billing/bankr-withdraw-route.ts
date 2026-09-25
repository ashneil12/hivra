// Shared core for the two Bankr agent-wallet withdraw routes:
//
//   POST /api/instances/[id]/bankr-wallet/withdraw     (Hermes instance lane)
//   POST /api/hivra/agents/[id]/bankr-wallet/withdraw  (Hivra-catalog lane)
//
// MONEY — these routes move real funds. The two lanes previously carried
// ~300 lines of byte-identical safety logic (zod body, ownership check, 3/60s
// rate limit, per-(user,id) in-memory lock, full status→HTTP map). Keeping two
// copies was a drift hazard, so the money-critical middle lives here and each
// lane supplies only what genuinely differs: ownership lookup, the host/type
// gates, the wallet-resolver entrypoint, and the log/failureType prefixes.
//
// Lanes MUST NOT diverge on the status→HTTP map — a status the service layer
// can produce must map to the same HTTP code and the same failureType suffix
// in both lanes. Add new statuses here, not in the route files.

import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import type { BankrWalletOwner } from "@/lib/billing/bankr-instance-wallets";
import type {
  BaseWithdrawalToken,
  InstanceBankrWithdrawAsset,
  InstanceBankrWithdrawResult,
} from "@/lib/billing/bankr-instance-withdraw";
import { log } from "@/lib/logger";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/supabase";

const baseTokenSchema = z.object({
  symbol: z.string().trim().min(1).max(24).regex(/^[a-zA-Z0-9._-]+$/),
  tokenAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/).nullable().optional(),
  decimals: z.number().int().min(0).max(36),
  chain: z.literal("Base"),
});

// A withdrawal never changes the saved destination: older clients may still
// send `setPrimaryRecipient`, and it is ignored (zod strips unknown keys).
// `recipientAddress` must equal the saved destination.
const bodySchema = z.object({
  expectedRecipient: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  recipientAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  amount: z.string().trim().min(1).max(80),
  asset: z.enum(["HERMESOS", "ETH"]).optional().default("HERMESOS"),
  token: baseTokenSchema.optional(),
}).superRefine((body, ctx) => {
  if (body.token && !body.recipientAddress) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recipientAddress"],
      message: "Recipient address is required for Base token withdrawals.",
    });
  }
});

export interface BankrWithdrawBody {
  expectedRecipient?: string;
  recipientAddress?: string;
  amount: string;
  asset: InstanceBankrWithdrawAsset;
  token?: BaseWithdrawalToken & { chain: "Base" };
}

function assetLabel(asset: string) {
  if (asset === "ETH") return "Base ETH";
  if (asset === "HERMESOS") return "$HERMESOS";
  return `Base ${asset}`;
}

async function readBody(req: NextRequest): Promise<BankrWithdrawBody> {
  try {
    const body = bodySchema.parse(await req.json());
    return {
      ...body,
      token: body.token
        ? {
            symbol: body.token.symbol,
            tokenAddress: body.token.tokenAddress ?? null,
            decimals: body.token.decimals,
            chain: "Base",
          }
        : undefined,
    };
  } catch (err) {
    if (err instanceof SyntaxError) bodySchema.parse({});
    throw err;
  }
}

export interface BankrWithdrawLogContext {
  source: string;
  route: string;
  method: string;
}

/**
 * Lane failure signal. The core builds the `apiError` (and its LOG_CONTEXT)
 * so both lanes emit identical routing metadata; `failureTypeSuffix` is
 * appended to the lane's prefix (e.g. `agent_not_found` →
 * `hivra_bankr_withdraw_agent_not_found`).
 */
export type BankrWithdrawRejection =
  | { ok: false; status: number; message: string; failureTypeSuffix: string }
  | { ok: true; owner: BankrWalletOwner };

export interface BankrWithdrawLane {
  /** LOG_CONTEXT (`source` / `route` / `method`) shared by every log line. */
  logContext: BankrWithdrawLogContext;
  /** Per-route in-memory lock map (separate per lane, keyed `${userId}:${id}`). */
  inFlight: Map<string, Promise<unknown>>;
  /** Rate-limit bucket key prefix, e.g. `agent-wallet-withdraw`. */
  rateLimitKeyPrefix: string;
  /** failureType prefix, e.g. `agent_wallet_withdraw` → `..._rate_limited`. */
  failureTypePrefix: string;
  /** Noun used in the no-wallet message: "instance" or "agent". */
  walletNoun: string;
  /** Prefix on the submit/transfer-failed log messages ("" or "hivra "). */
  logMessagePrefix: string;
  /** Optional host/flag gate; return a Response to short-circuit the request. */
  gate?: (req: NextRequest, logContext: BankrWithdrawLogContext) => Response | null;
  /** Ownership + type gate. Errors surface through the lane's failureType prefix. */
  loadOwner: (id: string, userId: string) => Promise<BankrWithdrawRejection>;
  /** Lane-specific wallet-resolver entrypoint. */
  withdraw: (args: {
    owner: BankrWalletOwner;
    id: string;
    userId: string;
    body: BankrWithdrawBody;
  }) => Promise<InstanceBankrWithdrawResult>;
}

/**
 * Build the `POST` handler for a Bankr withdraw lane. The returned handler is
 * byte-for-byte behaviour-identical across lanes apart from the config above.
 */
export function createBankrWithdrawHandler(lane: BankrWithdrawLane) {
  const LOG_CONTEXT = lane.logContext;
  const failureType = (suffix: string) => `${lane.failureTypePrefix}_${suffix}`;

  return async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    let userIdForLog: string | null = null;
    let idForLog: string | null = null;

    try {
      if (lane.gate) {
        const gated = lane.gate(req, LOG_CONTEXT);
        if (gated) return gated;
      }
      const { id } = await ctx.params;
      idForLog = id;
      const { userId } = await auth();
      userIdForLog = userId ?? null;
      if (!userId) return apiError("Unauthorized", 401, undefined, undefined, LOG_CONTEXT);
      if (!supabaseAdmin) return apiError("Database not configured", 500, undefined, undefined, LOG_CONTEXT);

      const owned = await lane.loadOwner(id, userId);
      if (!owned.ok) {
        return apiError(owned.message, owned.status, undefined, undefined, {
          ...LOG_CONTEXT,
          userId,
          instanceId: id,
          failureType: failureType(owned.failureTypeSuffix),
        });
      }
      const { owner } = owned;

      const rate = enforceRateLimit(`${lane.rateLimitKeyPrefix}:${userId}:${id}:${getIP(req)}`, {
        limit: 3,
        windowMs: 60_000,
      });
      if (!rate.success) {
        return apiError("Too many withdraw attempts. Please wait a minute.", 429, undefined, undefined, {
          ...LOG_CONTEXT,
          userId,
          instanceId: id,
          failureType: failureType("rate_limited"),
        });
      }

      const lockKey = `${userId}:${id}`;
      if (lane.inFlight.has(lockKey)) {
        return apiError("A withdraw is already in progress for this agent wallet.", 409, undefined, undefined, {
          ...LOG_CONTEXT,
          userId,
          instanceId: id,
          failureType: failureType("already_in_flight"),
        });
      }
      let releaseLock: () => void = () => {};
      lane.inFlight.set(lockKey, new Promise<void>((resolve) => {
        releaseLock = resolve;
      }));

      let result: InstanceBankrWithdrawResult;
      let asset: string = "HERMESOS";
      try {
        const body = await readBody(req);
        asset = body.token ? body.token.symbol.trim().toUpperCase() : body.asset;
        result = await lane.withdraw({ owner, id, userId, body });
      } finally {
        lane.inFlight.delete(lockKey);
        releaseLock();
      }

      if (result.status === "already_in_flight") {
        return apiError(
          result.errorMessage ?? "A withdraw is already in progress for this account.",
          409,
          undefined,
          undefined,
          {
            ...LOG_CONTEXT,
            userId,
            instanceId: id,
            failureType: failureType("already_in_flight"),
          }
        );
      }
      if (result.status === "no_wallet") {
        return apiError(`No active agent wallet found for this ${lane.walletNoun}.`, 404, undefined, undefined, {
          ...LOG_CONTEXT,
          userId,
          instanceId: id,
          failureType: failureType("no_wallet"),
        });
      }
      if (result.status === "invalid_token") {
        return apiError(
          result.errorMessage ?? "Enter a valid Base token and recipient.",
          400,
          {
            failureType: failureType("invalid_token"),
            asset,
          },
          undefined,
          {
            ...LOG_CONTEXT,
            userId,
            instanceId: id,
            failureType: failureType("invalid_token"),
            metadata: { asset },
          }
        );
      }
      if (result.status === "no_balance") {
        return apiError(`No ${assetLabel(asset)} balance to withdraw from this agent wallet.`, 422, undefined, undefined, {
          ...LOG_CONTEXT,
          userId,
          instanceId: id,
          failureType: failureType("no_balance"),
          metadata: { asset },
        });
      }
      if (result.status === "invalid_amount") {
        return apiError(
          result.errorMessage ?? `Enter a valid ${assetLabel(asset)} amount to withdraw.`,
          422,
          {
            failureType: failureType("invalid_amount"),
            asset,
          },
          undefined,
          {
            ...LOG_CONTEXT,
            userId,
            instanceId: id,
            failureType: failureType("invalid_amount"),
            metadata: { asset },
          }
        );
      }
      if (result.status === "insufficient_balance") {
        return apiError(
          result.errorMessage ?? `Requested withdrawal amount exceeds the live ${assetLabel(asset)} balance.`,
          422,
          {
            failureType: failureType("insufficient_balance"),
            asset,
            amountRaw: result.amountRaw ?? null,
          },
          undefined,
          {
            ...LOG_CONTEXT,
            userId,
            instanceId: id,
            failureType: failureType("insufficient_balance"),
            metadata: { asset },
          }
        );
      }
      if (result.status === "no_withdrawal_destination") {
        return apiError(
          result.errorMessage ?? "Set this agent wallet's withdrawal destination before withdrawing.",
          422,
          undefined,
          undefined,
          {
            ...LOG_CONTEXT,
            userId,
            instanceId: id,
            failureType: failureType("no_destination"),
          }
        );
      }
      if (result.status === "destination_cooling_down") {
        // The saved destination is inside its cooldown (see
        // withdraw-destination-policy.ts). Nothing was claimed or sent.
        return apiError(
          result.errorMessage ?? "This withdrawal destination was saved too recently. Try again later.",
          423,
          undefined,
          { failureType: failureType("destination_cooling_down"), availableAt: result.availableAt ?? null },
          {
            ...LOG_CONTEXT,
            userId,
            instanceId: id,
            failureType: failureType("destination_cooling_down"),
            metadata: { asset },
          }
        );
      }
      if (result.status === "recipient_not_destination") {
        return apiError(
          result.errorMessage ?? "Withdrawals go only to this wallet's saved withdrawal destination.",
          422,
          undefined,
          { failureType: failureType("recipient_not_destination") },
          {
            ...LOG_CONTEXT,
            userId,
            instanceId: id,
            failureType: failureType("recipient_not_destination"),
            metadata: { asset },
          }
        );
      }
      if (result.status === "not_configured") {
        return apiError("Agent wallet withdraw is not configured.", 503, undefined, undefined, {
          ...LOG_CONTEXT,
          userId,
          instanceId: id,
          failureType: failureType("not_configured"),
        });
      }
      if (result.status === "transfer_failed") {
        log.error(`${lane.logMessagePrefix}agent wallet withdraw transfer failed`, new Error("bankr_transfer_failed"), {
          ...LOG_CONTEXT,
          userId,
          instanceId: id,
          failureType: failureType("transfer_failed"),
          asset,
          amountRaw: result.amountRaw ?? null,
          recipientAddress: result.recipientAddress ?? null,
          errorMessage: result.errorMessage ?? null,
          reportOpsEvent: false,
        });
        return apiError("Agent wallet withdraw transfer failed. Try again in a moment.", 502, undefined, undefined, {
          ...LOG_CONTEXT,
          userId,
          instanceId: id,
          failureType: failureType("transfer_failed"),
          metadata: { asset },
        });
      }

      log.info(`${lane.logMessagePrefix}agent wallet withdraw submitted`, {
        ...LOG_CONTEXT,
        userId,
        instanceId: id,
        asset,
        txHash: result.txHash ?? null,
        amountRaw: result.amountRaw ?? null,
        recipientAddress: result.recipientAddress ?? null,
      });

      return apiSuccess({
        status: result.status,
        asset,
        txHash: result.txHash ?? null,
        amountRaw: result.amountRaw,
        amountDisplay: result.amountDisplay,
        recipientAddress: result.recipientAddress,
        wallet: result.wallet ?? null,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return apiError("Validation failed", 400, {
          failureType: failureType("validation_error"),
          issueCount: err.issues.length,
        }, { issues: err.issues }, {
          ...LOG_CONTEXT,
          userId: userIdForLog,
          instanceId: idForLog,
          failureType: failureType("validation_error"),
        });
      }

      return apiError("Failed to process agent wallet withdraw.", 500, {
        failureType: failureType("failed"),
        errorName: err instanceof Error ? err.name : typeof err,
      }, undefined, {
        ...LOG_CONTEXT,
        userId: userIdForLog,
        instanceId: idForLog,
        cause: err,
        failureType: failureType("failed"),
      });
    }
  };
}
