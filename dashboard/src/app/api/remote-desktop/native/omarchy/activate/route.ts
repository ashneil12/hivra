export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 120;

import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { z } from "zod";

import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  readBoundedJson,
} from "@/app/api/infrastructure/connections/request-security";
import { remoteDesktopResponse } from "@/app/api/remote-desktop/session-response";
import { enforceRateLimit } from "@/lib/rate-limit";
import { activateOmarchyNativeSession } from "@/lib/remote-computers/omarchy-native-activation";

const schema = z.object({
  computerId: z.string().uuid(),
  sessionId: z.string().uuid(),
  sessionToken: z.string().regex(/^hrs1_[A-Za-z0-9_-]{43}$/),
}).strict();

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return remoteDesktopResponse({ success: false, error: "Unauthorized" }, 401);
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) {
    return remoteDesktopResponse({ success: false, error: "Request denied" }, 403);
  }
  if (!enforceRateLimit(`omarchy_native_activate:${userId}`, { limit: 5, windowMs: 15 * 60_000 }).success) {
    return remoteDesktopResponse({ success: false, error: "Wait before activating this desktop again." }, 429);
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) {
    return remoteDesktopResponse({ success: false, error: "JSON required" }, 415);
  }
  const body = await readBoundedJson(request, 2_048, 5_000);
  if (!body.ok) {
    return remoteDesktopResponse({ success: false, error: "Invalid request" },
      body.reason === "too_large" ? 413 : body.reason === "timeout" ? 408 : 400);
  }
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) return remoteDesktopResponse({ success: false, error: "Invalid request" }, 400);
  const result = await activateOmarchyNativeSession(userId, parsed.data);
  if (!result.ok) {
    const uncertain = result.code === "activation_uncertain";
    return remoteDesktopResponse({
      success: false,
      code: result.code,
      error: uncertain
        ? "Activation was dispatched but its outcome is uncertain. This session is held and will not be retried."
        : "This Omarchy desktop is not ready for native activation.",
    }, 409);
  }
  return remoteDesktopResponse({ success: true, data: result }, 200);
}
