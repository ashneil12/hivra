export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  readBoundedJson,
} from "@/app/api/infrastructure/connections/request-security";
import { apiError, apiSuccess } from "@/lib/api-response";
import { launchWindowsByoIso, WindowsByoIsoError } from "@/lib/infrastructure/windows-byo-iso";

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) return apiError("Open Windows launch from this dashboard.", 403);
  if (!hasStrictJsonContentType(request)) return apiError("Send Windows launch settings as JSON.", 415);
  const parsedBody = await readBoundedJson(request, 8 * 1024, 5000);
  if (!parsedBody.ok) return apiError("Send complete Windows launch settings of at most 8 KB.", parsedBody.reason === "too_large" ? 413 : 400);
  const body = parsedBody.body;
  try {
    const agent = await launchWindowsByoIso(userId, userId, body);
    return apiSuccess({ agent, launchRequestId: (body as { launchRequestId?: unknown }).launchRequestId }, 202);
  } catch (error) {
    if (error instanceof WindowsByoIsoError) {
      const status = error.code === "invalid_request" ? 400
        : error.code === "request_conflict" || error.code === "target_unavailable" || error.code === "target_incompatible" || error.code === "iso_unavailable" ? 409
          : error.code === "provision_uncertain" ? 503 : 500;
      return apiError(error.message, status, undefined, { code: error.code });
    }
    return apiError("Windows setup could not be started.", 500);
  }
}
