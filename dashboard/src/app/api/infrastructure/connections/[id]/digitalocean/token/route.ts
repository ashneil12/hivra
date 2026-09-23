export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit, RATE_LIMIT_PRESETS } from "@/lib/authenticated-rate-limit";
import { replaceDigitalOceanToken } from "@/lib/hivra/do-managed-sessions";
import { DigitalOceanConnectionCreateSchema } from "@/lib/infrastructure/contracts";
import { hivraApiUnavailable, managedSessionFailure, noStore, readMutationBody, UUID } from "@/app/api/hivra/managed-sessions/route-support";

const Body = z.object({ apiToken: DigitalOceanConnectionCreateSchema.shape.credentials.shape.apiToken }).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore(apiError("Connection not found.", 404));
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "digitalocean_token_replace", userId, ...RATE_LIMIT_PRESETS.secretWrite });
  if (rateLimit) return noStore(rateLimit);
  const body = await readMutationBody(request, 4 * 1024);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.body);
  if (!parsed.success) return noStore(apiError(parsed.error.issues[0]?.message ?? "Paste a DigitalOcean token.", 400));
  try {
    return noStore(apiSuccess(await replaceDigitalOceanToken(userId, id.toLowerCase(), parsed.data.apiToken)));
  } catch (error) {
    return managedSessionFailure(error, "/api/infrastructure/connections/[id]/digitalocean/token");
  }
}
