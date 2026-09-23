export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
// Launch waits briefly for DigitalOcean to report READY (sub-second in the
// provider's own benchmark) and returns the observed state either way.
export const maxDuration = 60;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { launchDigitalOceanSession, listManagedSessions } from "@/lib/hivra/do-managed-sessions";
import { ManagedSessionLaunchSchema } from "@/lib/hivra/managed-session-contracts";
import { listDigitalOceanTargets } from "@/lib/infrastructure/digitalocean-store";
import { managedSessionFailure, noStore, readMutationBody, hivraApiUnavailable } from "./route-support";

export async function GET(request: NextRequest) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  try {
    const [sessions, targets] = await Promise.all([listManagedSessions(userId), listDigitalOceanTargets(userId)]);
    return noStore(apiSuccess({ sessions, targets }));
  } catch (error) {
    return managedSessionFailure(error, "/api/hivra/managed-sessions");
  }
}

export async function POST(request: NextRequest) {
  const unavailable = hivraApiUnavailable(request);
  if (unavailable) return unavailable;
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_managed_session_launch", userId, limit: 6, windowMs: 60_000 });
  if (rateLimit) return noStore(rateLimit);
  const body = await readMutationBody(request, 16 * 1024);
  if (!body.ok) return body.response;
  const parsed = ManagedSessionLaunchSchema.safeParse(body.body);
  if (!parsed.success) {
    return noStore(apiError(parsed.error.issues[0]?.message ?? "Check the launch settings.", 400));
  }
  try {
    return noStore(apiSuccess({ session: await launchDigitalOceanSession(userId, parsed.data) }, 201));
  } catch (error) {
    return managedSessionFailure(error, "/api/hivra/managed-sessions");
  }
}
