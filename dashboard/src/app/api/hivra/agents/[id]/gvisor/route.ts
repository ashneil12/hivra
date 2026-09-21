export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { GvisorComputerError, observeGvisorComputer } from "@/lib/hivra/gvisor-computer-service";

function failure(error: unknown) {
  if (error instanceof GvisorComputerError) return apiError(error.message,
    error.code === "not_found" ? 404 : error.code === "conflict" || error.code === "not_ready" ? 409 : 503,
    undefined, { code: error.code });
  return apiError("The gVisor computer operation could not be confirmed.", 500);
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { userId } = await auth(); if (!userId) return apiError("Unauthorized", 401);
  try { return apiSuccess({ observation: await observeGvisorComputer(userId, (await context.params).id) }); }
  catch (error) { return failure(error); }
}
