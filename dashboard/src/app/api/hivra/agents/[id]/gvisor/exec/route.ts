export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { executeGvisorComputerCommand, GvisorComputerError } from "@/lib/hivra/gvisor-computer-service";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

const Input = z.object({ argv: z.array(z.string().min(1).max(4096)).min(1).max(32) }).strict()
  .refine(value => value.argv.reduce((size, item) => size + Buffer.byteLength(item), 0) <= 16 * 1024);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { userId } = await auth(); if (!userId) return apiError("Unauthorized", 401);
  const rateLimit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_gvisor_exec", userId, limit: 20, windowMs: 60_000 });
  if (rateLimit) return rateLimit;
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) return apiError("Open this Computer terminal from Hivra.", 403);
  if (!hasStrictJsonContentType(request)) return apiError("Send command arguments as JSON.", 415);
  const body = await readBoundedJson(request, 20 * 1024, 5_000);
  const parsed = body.ok ? Input.safeParse(body.body) : null;
  if (!parsed?.success) return apiError("Send a bounded command and arguments.", 400);
  try { return apiSuccess({ result: await executeGvisorComputerCommand(userId, (await context.params).id, parsed.data.argv) }); }
  catch (error) {
    if (error instanceof GvisorComputerError) return apiError(error.message, error.code === "not_found" ? 404 : 503, undefined, { code: error.code });
    return apiError("The gVisor command could not be confirmed.", 500);
  }
}
