import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import {
  instanceBankrWalletPublicSummary,
  listWithdrawalRecipientsForInstance,
  setWithdrawalDestination,
} from "@/lib/billing/bankr-instance-wallets";
import { supabaseAdmin } from "@/lib/supabase";

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
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const ownsInstance = await verifyInstanceOwner(id, userId);
    if (!ownsInstance) return apiError("Instance not found", 404);

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
