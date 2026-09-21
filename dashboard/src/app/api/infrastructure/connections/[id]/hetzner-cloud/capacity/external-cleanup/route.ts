import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { verifyHetznerExternalCleanup, HetznerExternalCleanupError } from "@/lib/infrastructure/hetzner-external-cleanup";
import { HetznerExternalCleanupRequestSchema } from "@/lib/infrastructure/hetzner-external-cleanup-contracts";
import { hasStrictJsonContentType, isSameOriginMutationRequest, MAX_CAPACITY_REQUEST_BODY_BYTES, readBoundedJson } from "../../../../request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;
const noStore = (response: Response) => { response.headers.set("Cache-Control", "no-store"); return response; };

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(request)) return noStore(apiError("Same-origin request required.", 403));
    if (!hasStrictJsonContentType(request)) return noStore(apiError("Content-Type must be application/json.", 415));
    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Infrastructure operation not found.", 404));
    const limited = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hetzner_external_cleanup", userId, limit: 5, windowMs: 10 * 60_000 });
    if (limited) return noStore(limited);
    const body = await readBoundedJson(request, MAX_CAPACITY_REQUEST_BODY_BYTES);
    if (!body.ok) return noStore(apiError("Invalid verification request.", body.reason === "too_large" ? 413 : 400));
    const parsed = HetznerExternalCleanupRequestSchema.safeParse(body.body);
    if (!parsed.success) return noStore(apiError("Confirm the original purchase's external cleanup.", 400));
    return noStore(apiSuccess(await verifyHetznerExternalCleanup(userId, id.data, parsed.data)));
  } catch (error) {
    if (error instanceof HetznerExternalCleanupError) {
      return noStore(apiError("External cleanup could not be verified. The original claim is retained.",
        error.code === "not_found" ? 404 : error.code === "verification_unavailable" ? 503 : 409,
        undefined, { code: error.code }));
    }
    return noStore(apiError("Verification is unavailable. The original claim is retained.", 503));
  }
}
