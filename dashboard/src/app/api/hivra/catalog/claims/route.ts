// A maker's claim on a catalog page: read it (GET), get a line to prove it
// with, or have Hivra look for that line in the maker's repository (POST).
// Off with the Launch catalog switch. See lib/hivra/catalog-claims.ts.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { checkClaim, readClaimView, startClaim } from "@/lib/hivra/catalog-claims";
import { isLaunchProfileId } from "@/lib/launch/contracts";
import { isLaunchCatalogEnabled } from "@/lib/launch/launch-catalog";

const BodySchema = z.object({
  profile: z.string().refine(isLaunchProfileId),
  action: z.enum(["start", "check"]),
}).strict();

// GET /api/hivra/catalog/claims?profile=<id>
export async function GET(request: NextRequest) {
  try {
    if (!isLaunchCatalogEnabled()) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const profile = request.nextUrl.searchParams.get("profile");
    if (!isLaunchProfileId(profile)) return apiError("Unknown page", 400);
    return apiSuccess({ claim: await readClaimView(userId, profile) });
  } catch (err) {
    return handleApiError(err);
  }
}

// POST /api/hivra/catalog/claims { profile, action: "start" | "check" }
export async function POST(request: NextRequest) {
  try {
    if (!isLaunchCatalogEnabled()) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    // Each check reads a file from the maker's repository, so checks are paced.
    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "catalog_claims_write",
      userId,
      limit: 12,
      windowMs: 60_000,
    });
    if (rateLimitError) return rateLimitError;

    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !isLaunchProfileId(parsed.data.profile)) return apiError("Unknown page or action", 400);
    const { profile, action } = parsed.data;

    const claim = action === "start" ? await startClaim(userId, profile) : await checkClaim(userId, profile);
    if (!claim) {
      return action === "start"
        ? apiError("This page cannot be claimed", 400)
        : apiError("Start a claim before checking it", 409);
    }
    return apiSuccess({ claim });
  } catch (err) {
    return handleApiError(err);
  }
}
