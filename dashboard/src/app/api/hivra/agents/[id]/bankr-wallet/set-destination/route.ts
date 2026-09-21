// Hivra-lane Bankr wallet withdrawal-destination setter.
//
// The Hivra analogue of /api/instances/[id]/bankr-wallet/withdraw-destination.
// Persists the saved destination on the owner-agnostic
// `instance_bankr_wallets.withdrawal_destination_evm` column via
// setWithdrawalDestinationForOwner. It deliberately does NOT touch the
// instance-only `instance_bankr_wallet_recipients` table (its instance_id FK to
// hermes_instances would reject a Hivra box), so no migration is needed.

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import {
  instanceBankrWalletPublicSummary,
  setWithdrawalDestinationForOwner,
} from "@/lib/billing/bankr-instance-wallets";
import { bankrSkillsDirForType } from "@/lib/hivra/bankr-skills-seed";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const bodySchema = z.object({
  evmAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, "Enter a valid EVM address."),
});

interface HivraAgentRow {
  id: string;
  user_id: string;
  type: string;
}

async function loadOwnedAgent(id: string, userId: string): Promise<HivraAgentRow | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select("id,user_id,type")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error("Failed to verify agent ownership");
  }
  return (data as HivraAgentRow | null) || null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await ctx.params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const agent = await loadOwnedAgent(id, userId);
    if (!agent) return apiError("Agent not found", 404);
    if (!bankrSkillsDirForType(agent.type)) {
      return apiError("Wallet not supported for this agent type", 400);
    }

    const body = bodySchema.parse(await req.json());
    const record = await setWithdrawalDestinationForOwner({
      owner: { hivraAgentId: id },
      userId,
      destinationEvm: body.evmAddress,
    });

    return apiSuccess({ wallet: instanceBankrWalletPublicSummary(record) });
  } catch (err) {
    return handleApiError(err);
  }
}
