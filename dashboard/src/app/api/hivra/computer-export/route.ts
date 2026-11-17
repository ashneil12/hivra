export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { ComputerExportError } from "@/lib/hivra/computer-export/host";
import { getComputerExport, listComputerExports, startComputerExport } from "@/lib/hivra/computer-export/service";
import { log } from "@/lib/logger";

function failure(error: unknown) {
  if (error instanceof ComputerExportError) return apiError(error.message, error.status);
  // Never attach the request (it holds the passphrase) or the exception object.
  log.error("Computer export failed at an integration boundary", new Error("Computer export unverified"), {
    source: "computer-export", failureType: "computer_export_unverified",
  });
  return apiError("The export could not be checked right now. Try again in a minute.", 503);
}

/** Start an export: { agentId, passphrase }. */
export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!isSameOriginMutationRequest(request)) return apiError("Use the export page.", 403);
  if (!hasStrictJsonContentType(request)) return apiError("Expected application/json.", 415);
  const limited = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra-computer-export-start", userId, limit: 4, windowMs: 600_000 });
  if (limited) return limited;
  const parsed = await readBoundedJson(request, 4096, 10_000);
  if (!parsed.ok) return apiError("Invalid export request.", 400);
  const body = parsed.body as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.agentId !== "string") {
    return apiError("Choose one of your computers.", 400);
  }
  try {
    return apiSuccess(await startComputerExport(userId, body.agentId, body.passphrase));
  } catch (error) {
    return failure(error);
  }
}

/** One export's state (?id=), or the owner's recent exports. */
export async function GET(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  const limited = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra-computer-export-read", userId, limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  const id = request.nextUrl.searchParams.get("id");
  try {
    return apiSuccess(id ? await getComputerExport(userId, id) : await listComputerExports(userId));
  } catch (error) {
    return failure(error);
  }
}
