import {
  withdrawBaseEthForInstance,
  withdrawBaseTokenForInstance,
  withdrawHermesTokensForInstance,
} from "@/lib/billing/bankr-instance-withdraw";
import { createBankrWithdrawHandler } from "@/lib/billing/bankr-withdraw-route";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const LOG_CONTEXT = {
  source: "agent-wallet-withdraw",
  route: "/api/instances/[id]/bankr-wallet/withdraw",
  method: "POST",
};

const inFlightByInstance = new Map<string, Promise<unknown>>();

async function verifyInstanceOwner(instanceId: string, userId: string) {
  if (!supabaseAdmin) return { ok: false as const, status: 404, message: "Instance not found", failureTypeSuffix: "instance_not_found" };

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id")
    .eq("id", instanceId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to verify instance ownership");
  }

  if (!Boolean(data)) {
    return { ok: false as const, status: 404, message: "Instance not found", failureTypeSuffix: "instance_not_found" };
  }

  return { ok: true as const, owner: { instanceId } };
}

export const POST = createBankrWithdrawHandler({
  logContext: LOG_CONTEXT,
  inFlight: inFlightByInstance,
  rateLimitKeyPrefix: "agent-wallet-withdraw",
  failureTypePrefix: "agent_wallet_withdraw",
  walletNoun: "instance",
  logMessagePrefix: "",
  loadOwner: (id, userId) => verifyInstanceOwner(id, userId),
  withdraw: async ({ id, userId, body }) => {
    if (body.token) {
      return withdrawBaseTokenForInstance({
        instanceId: id,
        userId,
        recipientAddress: body.recipientAddress!,
        amountDisplay: body.amount,
        token: {
          symbol: body.token.symbol,
          tokenAddress: body.token.tokenAddress,
          decimals: body.token.decimals,
        },
        setPrimaryRecipient: body.setPrimaryRecipient,
      });
    }
    const withdraw = body.asset === "ETH" ? withdrawBaseEthForInstance : withdrawHermesTokensForInstance;
    return withdraw({
      instanceId: id,
      userId,
      expectedRecipient: body.expectedRecipient,
      amountDisplay: body.amount,
    });
  },
});
