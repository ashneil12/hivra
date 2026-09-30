export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { loadHetznerCloudCapacitySlot } from "@/lib/infrastructure/hetzner-cloud-store";

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** Read-only: whether this account's one in-app Hetzner server slot is used,
 * so Create can be disabled with its reason before a quote. The purchase-time
 * claim stays authoritative. */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const limited = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "hetzner_cloud_capacity_slot_read",
      userId,
      limit: 60,
      windowMs: 60_000,
    });
    if (limited) return noStore(limited);
    return noStore(apiSuccess({ slot: await loadHetznerCloudCapacitySlot(userId) }));
  } catch (error) {
    return noStore(apiError(
      "Hetzner server availability could not be checked.",
      500,
      { failureType: "hetzner_cloud_capacity_slot_failed", errorName: error instanceof Error ? error.name : typeof error },
    ));
  }
}
