export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { HetznerCleanupRequestSchema } from "@/lib/infrastructure/hetzner-cleanup-contracts";
import { HetznerCleanupError } from "@/lib/infrastructure/hetzner-cleanup-policy";
import { advanceHetznerCleanup, listHetznerCleanup, previewHetznerCleanup } from "@/lib/infrastructure/hetzner-cleanup";
import { hasStrictJsonContentType, isSameOriginMutationRequest, MAX_CAPACITY_REQUEST_BODY_BYTES, readBoundedJson } from "../../../../request-security";

const Uuid = z.string().uuid();
type Context = { params: Promise<{ id: string }> };
const noStore = (response: Response) => { response.headers.set("Cache-Control","no-store"); return response; };
function failure(error: unknown) {
  if (error instanceof InfrastructureConnectionStoreError && error.code === "not_found") {
    return noStore(apiError("Infrastructure operation not found.",404));
  }
  if (error instanceof HetznerCleanupError) {
    return noStore(apiError("Cleanup needs attention. Review the original resources before continuing.",409,undefined,{code:error.code}));
  }
  return noStore(apiError("Cleanup could not be confirmed. Reopen this same operation to inspect its saved state.",503,undefined,{code:"provider_unavailable"}));
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized",401));
    const id = Uuid.safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Infrastructure connection not found.",404));
    const limited = enforceAuthenticatedRouteRateLimit(request,{routeKey:"hetzner_cleanup_read",userId,limit:30,windowMs:60_000});
    if (limited) return noStore(limited);
    const orderId = request.nextUrl.searchParams.get("orderId");
    if (orderId === null) return noStore(apiSuccess(await listHetznerCleanup(userId,id.data)));
    if (!Uuid.safeParse(orderId).success) return noStore(apiError("Invalid operation.",400));
    return noStore(apiSuccess(await previewHetznerCleanup(userId,id.data,orderId)));
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized",401));
    if (!isSameOriginMutationRequest(request)) return noStore(apiError("Same-origin request required.",403));
    if (!hasStrictJsonContentType(request)) return noStore(apiError("Content-Type must be application/json.",415));
    const id = Uuid.safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Infrastructure connection not found.",404));
    const limited = enforceAuthenticatedRouteRateLimit(request,{routeKey:"hetzner_cleanup_advance",userId,limit:12,windowMs:10*60_000});
    if (limited) return noStore(limited);
    const body = await readBoundedJson(request,MAX_CAPACITY_REQUEST_BODY_BYTES);
    if (!body.ok) return noStore(apiError("Invalid cleanup request.",body.reason === "too_large" ? 413 : 400));
    const parsed = HetznerCleanupRequestSchema.safeParse(body.body);
    if (!parsed.success) return noStore(apiError("Confirm the exact original server before deleting.",400));
    const result = await advanceHetznerCleanup(userId,id.data,parsed.data);
    return noStore(apiSuccess(result,result.status === "deleted" ? 200 : 202));
  } catch (error) { return failure(error); }
}
