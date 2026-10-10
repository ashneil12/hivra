export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { setDigitalOceanTokenExpiry } from "@/lib/hivra/do-managed-sessions";
import { ProviderTokenExpiryInputSchema } from "@/lib/infrastructure/contracts";
import { hivraApiUnavailable, managedSessionFailure, noStore, readMutationBody, UUID } from "@/app/api/hivra/managed-sessions/route-support";

const Body = z.object({ tokenExpiry: ProviderTokenExpiryInputSchema }).strict();

/** Record when the owner says this connection's token expires. The token is untouched. */
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore(apiError("Connection not found.", 404));
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "digitalocean_token_expiry", userId, limit: 20, windowMs: 60_000 });
  if (rateLimit) return noStore(rateLimit);
  const body = await readMutationBody(request, 1024);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.body);
  if (!parsed.success) return noStore(apiError(parsed.error.issues[0]?.message ?? "Choose a date or No expiry.", 400));
  try {
    return noStore(apiSuccess({ credentialExpiry: await setDigitalOceanTokenExpiry(userId, id.toLowerCase(), parsed.data.tokenExpiry) }));
  } catch (error) {
    return managedSessionFailure(error, "/api/infrastructure/connections/[id]/digitalocean/token-expiry");
  }
}
