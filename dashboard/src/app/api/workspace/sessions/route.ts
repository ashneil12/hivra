export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 40;

import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { z } from "zod";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { remoteDesktopResponse } from "@/app/api/remote-desktop/session-response";
import { issueProviderWorkspaceSession, revokeProviderWorkspaceSession, WorkspaceIssueRequest } from "@/lib/hivra/provider-workspace-session-issuer";
import { enforceRateLimit } from "@/lib/rate-limit";

async function ownerRequest(request: NextRequest, kind: "issue" | "revoke") {
  const { userId } = await auth();
  if (!userId) return { response: remoteDesktopResponse({ success: false }, 401) };
  const key = "NEXT_PUBLIC_APP_URL";
  if (request.nextUrl.search || !isSameOriginMutationRequest(request) || request.headers.get("origin") !== process.env[key]) {
    return { response: remoteDesktopResponse({ success: false }, 403) };
  }
  if (!enforceRateLimit(`workspace_${kind}:${userId}`, { limit: kind === "issue" ? 12 : 120, windowMs: 60_000 }).success) {
    return { response: remoteDesktopResponse({ success: false }, 429) };
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) return { response: remoteDesktopResponse({ success: false }, 415) };
  const body = await readBoundedJson(request, 1024, 5000);
  if (!body.ok) return { response: remoteDesktopResponse({ success: false }, body.reason === "too_large" ? 413 : body.reason === "timeout" ? 408 : 400) };
  return { userId, body: body.body };
}

export async function POST(request: NextRequest) {
  const result = await ownerRequest(request, "issue");
  if (result.response) return result.response;
  const body = WorkspaceIssueRequest.safeParse(result.body);
  if (!body.success) return remoteDesktopResponse({ success: false }, 400);
  const issued = await issueProviderWorkspaceSession({ ...body.data, userId: result.userId });
  return issued.ok ? remoteDesktopResponse({ success: true, data: issued.session }, 201)
    : remoteDesktopResponse({ success: false, code: issued.code, error: issued.error }, 409);
}

export async function DELETE(request: NextRequest) {
  const result = await ownerRequest(request, "revoke");
  if (result.response) return result.response;
  const body = z.object({ sessionId: z.string().uuid() }).strict().safeParse(result.body);
  if (!body.success) return remoteDesktopResponse({ success: false }, 400);
  const revoked = await revokeProviderWorkspaceSession({ ...body.data, userId: result.userId });
  return remoteDesktopResponse({ success: revoked.ok }, revoked.ok ? 200 : 503);
}
