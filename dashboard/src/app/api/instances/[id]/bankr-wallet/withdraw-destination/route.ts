import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import {
  instanceBankrWalletPublicSummary,
  listWithdrawalRecipientsForInstance,
  setWithdrawalDestination,
} from "@/lib/billing/bankr-instance-wallets";
import { withdrawDestinationStepUpResponse } from "@/lib/billing/withdraw-destination-notice";
import { supabaseAdmin } from "@/lib/supabase";

// Changing where an agent wallet's funds are withdrawn to needs a fresh
// sign-in check (Clerk reverification), emails the owner, and holds the new
// destination for the cooldown (withdraw-destination-policy.ts).
const ROUTE = "/api/instances/[id]/bankr-wallet/withdraw-destination";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const bodySchema = z.object({
  destination: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, "Enter a valid EVM address."),
});

async function verifyInstanceOwner(instanceId: string, userId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id")
    .eq("id", instanceId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to verify instance ownership");
  }

  return Boolean(data);
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const authObject = await auth();
    const { userId } = authObject;
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const ownsInstance = await verifyInstanceOwner(id, userId);
    if (!ownsInstance) return apiError("Instance not found", 404);

    const stepUp = withdrawDestinationStepUpResponse(authObject, { route: ROUTE, userId });
    if (stepUp) return stepUp;

    const body = bodySchema.parse(await req.json());
    const record = await setWithdrawalDestination({
      instanceId: id,
      userId,
      destinationEvm: body.destination,
    });

    return apiSuccess({
      wallet: instanceBankrWalletPublicSummary(record),
      withdrawalRecipients: await listWithdrawalRecipientsForInstance({ instanceId: id, userId }),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
