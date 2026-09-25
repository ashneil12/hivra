// Hivra-lane Bankr wallet withdraw (codex / claude-code boxes).
//
// MONEY — moves real funds. This is the Hivra analogue of
// /api/instances/[id]/bankr-wallet/withdraw. The shared safety core (zod body,
// ownership check, 3/60s rate limit, per-(user,agent) in-memory lock, full
// status→HTTP map) lives in @/lib/billing/bankr-withdraw-route; this file
// supplies only what differs: an isHivraApiAllowed host gate, a
// bankrSkillsDirForType type gate, ownership against hivra_agents, and the
// hivra_bankr_withdraw_* failureType prefix.
//
// The wallet is resolved by hivra_agent_id via the owner-agnostic
// withdrawForOwner — NEVER the instance-locked helper, which would target the
// wrong wallet. The per-user DB in-flight claim is shared across lanes, so a
// concurrent Hermes withdraw for the same user surfaces as a 409.

import { apiError } from "@/lib/api-response";
import { isUserConnectedBankrWallet } from "@/lib/billing/bankr-instance-wallets";
import { withdrawForOwner } from "@/lib/billing/bankr-instance-withdraw";
import { createBankrWithdrawHandler } from "@/lib/billing/bankr-withdraw-route";
import { bankrSkillsDirForType } from "@/lib/hivra/bankr-skills-seed";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

const LOG_CONTEXT = {
  source: "hivra-bankr-wallet-withdraw",
  route: "/api/hivra/agents/[id]/bankr-wallet/withdraw",
  method: "POST",
};

const inFlightByAgent = new Map<string, Promise<unknown>>();

interface HivraAgentRow {
  id: string;
  user_id: string;
  type: string;
}

async function loadOwnedAgent(id: string, userId: string) {
  if (!supabaseAdmin) {
    return { ok: false as const, status: 404, message: "Agent not found", failureTypeSuffix: "agent_not_found" };
  }
  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select("id,user_id,type")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error("Failed to verify agent ownership");
  }
  const agent = (data as HivraAgentRow | null) || null;
  if (!agent) {
    return { ok: false as const, status: 404, message: "Agent not found", failureTypeSuffix: "agent_not_found" };
  }
  if (!bankrSkillsDirForType(agent.type)) {
    return { ok: false as const, status: 400, message: "Wallet not supported for this agent type", failureTypeSuffix: "unsupported_type" };
  }
  // Hivra never initiates transfers from a user's own Bankr account: the user
  // moves those funds at bankr.bot. Only Hivra-provisioned wallets withdraw here.
  if (await isUserConnectedBankrWallet({ owner: { hivraAgentId: id } })) {
    return {
      ok: false as const,
      status: 409,
      message: "This agent uses your own Bankr account. Move its funds at bankr.bot.",
      failureTypeSuffix: "user_connected_wallet",
    };
  }
  return { ok: true as const, owner: { hivraAgentId: id } };
}

export const POST = createBankrWithdrawHandler({
  logContext: LOG_CONTEXT,
  inFlight: inFlightByAgent,
  rateLimitKeyPrefix: "hivra-bankr-wallet-withdraw",
  failureTypePrefix: "hivra_bankr_withdraw",
  walletNoun: "agent",
  logMessagePrefix: "hivra ",
  gate: (req, logContext) => (isHivraApiAllowed(req.headers.get("host")) ? null : apiError("Not found", 404, undefined, undefined, logContext)),
  loadOwner: (id, userId) => loadOwnedAgent(id, userId),
  withdraw: async ({ owner, id, userId, body }) => {
    if (body.token) {
      return withdrawForOwner({
        owner,
        userId,
        recipientAddress: body.recipientAddress!,
        amountDisplay: body.amount,
        token: {
          symbol: body.token.symbol,
          tokenAddress: body.token.tokenAddress,
          decimals: body.token.decimals,
        },
      });
    }
    return withdrawForOwner({
      owner,
      userId,
      expectedRecipient: body.expectedRecipient,
      amountDisplay: body.amount,
      asset: body.asset,
    });
  },
});
