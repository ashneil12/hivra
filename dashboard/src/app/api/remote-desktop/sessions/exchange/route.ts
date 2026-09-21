export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest } from "next/server";
import { z } from "zod";

import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  readBoundedJson,
} from "@/app/api/infrastructure/connections/request-security";
import { exchangeRemoteDesktopSession } from "@/lib/remote-computers/session-broker";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { remoteDesktopResponse } from "../../session-response";

const schema = z.object({
  exchangeCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
}).strict();

export async function POST(request: NextRequest) {
  if (request.nextUrl.search) return remoteDesktopResponse({ success: false, error: "Request denied" }, 403);
  const hasBrowserHeaders = request.headers.has("origin") || request.headers.has("sec-fetch-site");
  if (hasBrowserHeaders && !isSameOriginMutationRequest(request)) {
    return remoteDesktopResponse({ success: false, error: "Request denied" }, 403);
  }
  if (!enforceRateLimit(`remote_desktop_exchange:${getIP(request)}`, { limit: 60, windowMs: 60_000 }).success) {
    return remoteDesktopResponse({ success: false, error: "Too many requests" }, 429);
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) {
    return remoteDesktopResponse({ success: false, error: "JSON required" }, 415);
  }
  const body = await readBoundedJson(request, 2_048, 5_000);
  if (!body.ok) {
    const status = body.reason === "too_large" ? 413 : body.reason === "timeout" ? 408 : 400;
    return remoteDesktopResponse({ success: false, error: "Invalid request" }, status);
  }
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) return remoteDesktopResponse({ success: false, error: "Invalid request" }, 400);
  const result = await exchangeRemoteDesktopSession(parsed.data);
  if (!result.ok) return remoteDesktopResponse({ success: false, error: result.error, code: result.code }, result.status);
  return remoteDesktopResponse({ success: true, data: result.grant }, 200);
}
