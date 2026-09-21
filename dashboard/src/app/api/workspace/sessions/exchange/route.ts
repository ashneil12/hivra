export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest } from "next/server";
import { hasStrictJsonContentType, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { remoteDesktopResponse } from "@/app/api/remote-desktop/session-response";
import { exchangeWorkspaceSession, WorkspaceExchange } from "@/lib/hivra/workspace-session-broker";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  // Only the guest broker may exchange. A dashboard or guest document must
  // never receive the resulting control-plane session bearer directly.
  if (request.nextUrl.search || ["origin", "sec-fetch-site", "cookie", "authorization"].some(name => request.headers.has(name))) {
    return remoteDesktopResponse({ success: false }, 403);
  }
  if (!enforceRateLimit(`workspace_exchange:${getIP(request)}`, { limit: 60, windowMs: 60_000 }).success) {
    return remoteDesktopResponse({ success: false }, 429);
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) return remoteDesktopResponse({ success: false }, 415);
  const body = await readBoundedJson(request, 2048, 5000);
  if (!body.ok) return remoteDesktopResponse({ success: false }, body.reason === "too_large" ? 413 : body.reason === "timeout" ? 408 : 400);
  const parsed = WorkspaceExchange.safeParse(body.body);
  if (!parsed.success) return remoteDesktopResponse({ success: false }, 400);
  const result = await exchangeWorkspaceSession(parsed.data);
  return result.ok ? remoteDesktopResponse({ success: true, data: result.grant }, 200) : remoteDesktopResponse({ success: false }, 403);
}
