export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import {
  getHetznerCloudOfferCatalog,
  HetznerCloudConnectionError,
} from "@/lib/infrastructure/hetzner-cloud";

const ConnectionIdSchema = z.string().uuid();
type RouteContext = { params: Promise<{ id: string }> };

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function failure(error: unknown): Response {
  if (error instanceof InfrastructureConnectionStoreError) {
    if (error.code === "not_found") {
      return noStore(apiError("Infrastructure connection not found.", 404));
    }
    if (error.code === "invalid_request") {
      return noStore(apiError("This is not a Hetzner Cloud connection.", 422));
    }
    if (error.code === "credential_error") {
      return noStore(apiError("Hetzner Cloud credentials are unavailable.", 422));
    }
  }
  if (error instanceof HetznerCloudConnectionError) {
    if (error.code === "invalid_credentials") {
      return noStore(apiError("Hetzner Cloud rejected this project API token.", 422));
    }
    return noStore(apiError("Hetzner Cloud offerings could not be loaded.", 502));
  }
  return noStore(
    apiError("Hetzner Cloud offerings could not be loaded.", 500, {
      failureType: "hetzner_cloud_catalog_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }),
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "hetzner_cloud_offer_catalog",
      userId,
      limit: 10,
      windowMs: 60_000,
    });
    if (rateLimitError) return noStore(rateLimitError);
    const parsedId = ConnectionIdSchema.safeParse((await context.params).id);
    if (!parsedId.success) {
      return noStore(apiError("Infrastructure connection not found.", 404));
    }
    const catalog = await getHetznerCloudOfferCatalog(userId, parsedId.data);
    return noStore(apiSuccess({ catalog }));
  } catch (error) {
    return failure(error);
  }
}
