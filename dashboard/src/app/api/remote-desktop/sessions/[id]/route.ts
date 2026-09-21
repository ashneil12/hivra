export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";

import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { revokeRemoteDesktopSession } from "@/lib/remote-computers/session-broker";
import { enforceRateLimit } from "@/lib/rate-limit";
import { remoteDesktopResponse } from "../../session-response";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return remoteDesktopResponse({ success: false, error: "Unauthorized" }, 401);
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) {
    return remoteDesktopResponse({ success: false, error: "Request denied" }, 403);
  }
  if (!enforceRateLimit(`remote_desktop_revoke:${userId}`, { limit: 60, windowMs: 60_000 }).success) {
    return remoteDesktopResponse({ success: false, error: "Too many requests" }, 429);
  }
  const { id } = await params;
  const result = await revokeRemoteDesktopSession({ userId, sessionId: id, reason: "user_revoked" });
  if (!result.ok) return remoteDesktopResponse({ success: false, error: result.error, code: result.code }, result.status);
  return remoteDesktopResponse({ success: true, data: { inputState: result.inputState } }, 200);
}
