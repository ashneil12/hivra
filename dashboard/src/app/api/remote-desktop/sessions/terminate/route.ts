export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest } from "next/server";
import { z } from "zod";

import {
  hasStrictJsonContentType,
  readBoundedJson,
} from "@/app/api/infrastructure/connections/request-security";
import {
  revokeRemoteDesktopSessionByToken,
  SESSION_TOKEN_RE,
} from "@/lib/remote-computers/session-broker";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { remoteDesktopResponse } from "../../session-response";

const schema = z.object({
  reason: z.enum(["connection_closed", "computer_stopping", "security_event"]),
}).strict();

export async function POST(request: NextRequest) {
  if (
    request.nextUrl.search || request.headers.has("origin")
    || request.headers.has("sec-fetch-site") || request.headers.has("cookie")
  ) return remoteDesktopResponse({ revoked: false }, 403);
  if (!enforceRateLimit(`remote_desktop_terminate:${getIP(request)}`, { limit: 120, windowMs: 60_000 }).success) {
    return remoteDesktopResponse({ revoked: false }, 429);
  }
  const authorization = request.headers.get("authorization");
  const sessionToken = authorization?.match(/^Bearer (hrs1_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!sessionToken || !SESSION_TOKEN_RE.test(sessionToken)) {
    return remoteDesktopResponse({ revoked: false }, 401);
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) {
    return remoteDesktopResponse({ revoked: false }, 415);
  }
  const body = await readBoundedJson(request, 512, 5_000);
  if (!body.ok) return remoteDesktopResponse({ revoked: false }, body.reason === "too_large" ? 413 : 400);
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) return remoteDesktopResponse({ revoked: false }, 400);
  const result = await revokeRemoteDesktopSessionByToken({
    sessionToken,
    reason: parsed.data.reason,
  });
  if (!result.ok) return remoteDesktopResponse({ revoked: false }, result.status);
  return remoteDesktopResponse({ revoked: true, inputState: result.inputState }, 200);
}
