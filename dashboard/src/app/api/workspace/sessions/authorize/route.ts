export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest } from "next/server";
import { hasStrictJsonContentType, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { remoteDesktopResponse } from "@/app/api/remote-desktop/session-response";
import { authorizeWorkspaceSession, WorkspaceBinding } from "@/lib/hivra/workspace-session-broker";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  if (request.nextUrl.search || ["origin", "sec-fetch-site", "cookie"].some(name => request.headers.has(name))) {
    return remoteDesktopResponse({ authorized: false }, 403);
  }
  // 64 ledger sessions need 768 maintenance checks/minute. Leave headroom
  // for file requests and socket admission; this is an abuse ceiling, not capacity.
  if (!enforceRateLimit(`workspace_authorize:${getIP(request)}`, { limit: 4096, windowMs: 60_000 }).success) {
    return remoteDesktopResponse({ authorized: false }, 429);
  }
  const sessionToken = request.headers.get("authorization")?.match(/^Bearer (hws1_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!sessionToken) return remoteDesktopResponse({ authorized: false }, 401);
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) return remoteDesktopResponse({ authorized: false }, 415);
  const body = await readBoundedJson(request, 1024, 5000);
  if (!body.ok) return remoteDesktopResponse({ authorized: false }, body.reason === "too_large" ? 413 : body.reason === "timeout" ? 408 : 400);
  const parsed = WorkspaceBinding.safeParse(body.body);
  if (!parsed.success) return remoteDesktopResponse({ authorized: false }, 400);
  const result = await authorizeWorkspaceSession({ ...parsed.data, sessionToken });
  return result.ok ? remoteDesktopResponse({ authorized: true, data: result.grant }, 200) : remoteDesktopResponse({ authorized: false }, 403);
}
