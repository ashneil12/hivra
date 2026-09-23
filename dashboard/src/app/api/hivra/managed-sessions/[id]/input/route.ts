export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { sendManagedSessionInput } from "@/lib/hivra/do-managed-sessions";
import { ManagedSessionInputSchema } from "@/lib/hivra/managed-session-contracts";
import { managedSessionFailure, noStore, readMutationBody, UUID, hivraApiUnavailable } from "../../route-support";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore(apiError("Agent not found.", 404));
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_managed_session_input", userId, limit: 30, windowMs: 60_000 });
  if (rateLimit) return noStore(rateLimit);
  const body = await readMutationBody(request, 40 * 1024);
  if (!body.ok) return body.response;
  const parsed = ManagedSessionInputSchema.safeParse(body.body);
  if (!parsed.success) return noStore(apiError(parsed.error.issues[0]?.message ?? "Type a message.", 400));
  try {
    return noStore(apiSuccess(await sendManagedSessionInput(userId, id.toLowerCase(), parsed.data.text)));
  } catch (error) {
    return managedSessionFailure(error, "/api/hivra/managed-sessions/[id]/input");
  }
}
