export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { createBuzzCoordinator } from "@/lib/hivra/buzz-coordinator";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { buzzFailure, noStore, readBuzzMutation } from "../route-utils";

const BindSchema = z.object({
  connectionId: z.string().uuid(),
  agentId: z.string().uuid(),
  operationId: z.string().uuid(),
  inviteCode: z.string().trim().min(1).max(2_048),
}).strict();

export async function POST(request: NextRequest) {
  try {
    if (!isHivraApiAllowed(request.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const mutation = await readBuzzMutation(request, userId, "hivra_buzz_bind_agent");
    if (!mutation.ok) return mutation.response;
    const parsed = BindSchema.safeParse(mutation.body);
    if (!parsed.success) return noStore(apiError("Choose an agent and enter a valid Buzz invite.", 400));
    return noStore(apiSuccess(await createBuzzCoordinator().bind(userId, parsed.data)));
  } catch (error) {
    return buzzFailure(error);
  }
}
