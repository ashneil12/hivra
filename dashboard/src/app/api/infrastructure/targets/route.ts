export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  InfrastructureConnectionStoreError,
  listInfrastructureDeploymentTargets,
} from "@/lib/infrastructure/connection-store";

const DeploymentTargetListQuerySchema = z
  .object({
    connectionId: z.string().uuid().optional(),
  })
  .strict();

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function parseListQuery(request: NextRequest) {
  const entries = Array.from(request.nextUrl.searchParams.entries());
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) return null;
  const parsed = DeploymentTargetListQuerySchema.safeParse(Object.fromEntries(entries));
  return parsed.success ? parsed.data : null;
}

function storeFailure(error: unknown): Response {
  if (
    error instanceof InfrastructureConnectionStoreError &&
    error.code === "database_unavailable"
  ) {
    return noStore(apiError("Database not configured", 500));
  }

  return noStore(
    apiError(
      "Failed to list infrastructure targets.",
      500,
      {
        failureType: "infrastructure_targets_get_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
      undefined,
      {
        source: "infrastructure/targets",
        route: "/api/infrastructure/targets",
        method: "GET",
        failureType: "infrastructure_targets_get_failed",
        cause: error,
      },
    ),
  );
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));

    const query = parseListQuery(request);
    if (!query) {
      return noStore(apiError("Invalid infrastructure target query.", 400));
    }

    const targets = await listInfrastructureDeploymentTargets(userId, query);
    return noStore(apiSuccess({ targets }));
  } catch (error) {
    return storeFailure(error);
  }
}
