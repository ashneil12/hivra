export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit, RATE_LIMIT_PRESETS } from "@/lib/authenticated-rate-limit";
import { HomeConnectorError, homeConnectorEnabled, startHomeConnectorEnrolment } from "@/lib/infrastructure/home-connector";
import { log } from "@/lib/logger";
import { isSameOriginMutationRequest } from "../connections/request-security";

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** Whether "connect a machine on your network" is on here. The flag itself stays on the server. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  return noStore(apiSuccess({ enabled: homeConnectorEnabled() }));
}

/** Start connecting a machine: returns the one command to paste, once. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(request)) return noStore(apiError("Same-origin request required.", 403));
    if (!homeConnectorEnabled()) return noStore(apiError("Not available.", 404));
    const limited = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "infrastructure_home_connector_start",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (limited) return noStore(limited);
    const enrolment = await startHomeConnectorEnrolment(userId);
    return noStore(apiSuccess({ enrolment }, 201));
  } catch (error) {
    if (error instanceof HomeConnectorError) {
      return noStore(apiError(error.message, error.code === "disabled" ? 404 : error.code === "too_many" ? 429 : 503));
    }
    log.warn("Home connector enrolment could not start", { source: "home-connector-route", failureType: "enrolment_start_failed" });
    return noStore(apiError("Hivra could not start connecting a machine. Try again shortly.", 503));
  }
}
