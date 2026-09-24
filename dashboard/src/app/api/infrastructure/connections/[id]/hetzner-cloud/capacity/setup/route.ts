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
import { listProviderComputerSetupEvidence, advanceProviderComputerSetup, ProviderComputerSetupError } from "@/lib/infrastructure/provider-computer-setup";
import { ProviderComputerSetupRequestSchema } from "@/lib/infrastructure/provider-computer-setup-contracts";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "../../../../request-security";

type RouteContext = { params: Promise<{ id: string }> };
function noStore(response: Response) { response.headers.set("Cache-Control", "no-store"); return response; }
function failure(error: unknown) {
  if (error instanceof InfrastructureConnectionStoreError && error.code === "not_found") return noStore(apiError("Infrastructure computer not found.", 404));
  const code = error instanceof ProviderComputerSetupError ? error.code : "setup_failed";
  const message = code === "connection_changed" ? "The connection changed. Reopen setup before continuing."
    : code === "setup_not_active" ? "This computer has no active setup recipe. Inspect the saved setup; do not create a replacement to recover an uncertain operation."
      : "This setup step could not be confirmed. The original computer and operation are retained. Check the connection and resume this same setup.";
  return noStore(apiError(message, 409, undefined, { code }));
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const limited = enforceAuthenticatedRouteRateLimit(request, { routeKey: "provider_setup_read", userId, limit: 60, windowMs: 60_000 });
    if (limited) return noStore(limited);
    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Infrastructure connection not found.", 404));
    return noStore(apiSuccess(await listProviderComputerSetupEvidence(userId, id.data)));
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(request)) return noStore(apiError("Same-origin request required.", 403));
    if (!hasStrictJsonContentType(request)) return noStore(apiError("Content-Type must be application/json.", 415));
    const limited = enforceAuthenticatedRouteRateLimit(request, { routeKey: "provider_setup_advance", userId, limit: 120, windowMs: 15 * 60_000 });
    if (limited) return noStore(limited);
    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Infrastructure connection not found.", 404));
    const body = await readBoundedJson(request, 1024);
    if (!body.ok) return noStore(apiError("Invalid setup request.", body.reason === "too_large" ? 413 : 400));
    const parsed = ProviderComputerSetupRequestSchema.safeParse(body.body);
    if (!parsed.success) return noStore(apiError("Invalid setup request.", 400));
    const computer = await advanceProviderComputerSetup(userId, id.data, parsed.data);
    return noStore(apiSuccess({ computer }, computer.stage === "environment_prepared" ? 200 : 202));
  } catch (error) { return failure(error); }
}
