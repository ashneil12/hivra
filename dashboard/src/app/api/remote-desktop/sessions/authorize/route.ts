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
  authorizeRemoteDesktopSession,
  SESSION_TOKEN_RE,
} from "@/lib/remote-computers/session-broker";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { remoteDesktopResponse } from "../../session-response";

const schema = z.object({
  computerKind: z.enum(["hermes-instance", "hivra-agent"]),
  computerId: z.string().uuid(),
  transport: z.enum([
    "sunshine-moonlight",
    "selkies-webrtc",
    "selkies-websocket",
    "recovery-console",
  ]),
  wantsInput: z.boolean(),
}).strict();

export async function POST(request: NextRequest) {
  // Broker-to-control-plane only: browsers, URL capabilities and cookies are
  // not alternate authentication channels for this endpoint.
  if (
    request.nextUrl.search || request.headers.has("origin")
    || request.headers.has("sec-fetch-site") || request.headers.has("cookie")
  ) return remoteDesktopResponse({ authorized: false }, 403);
  if (!enforceRateLimit(`remote_desktop_authorize:${getIP(request)}`, { limit: 300, windowMs: 60_000 }).success) {
    return remoteDesktopResponse({ authorized: false }, 429);
  }
  const authorization = request.headers.get("authorization");
  const sessionToken = authorization?.match(/^Bearer (hrs1_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!sessionToken || !SESSION_TOKEN_RE.test(sessionToken)) {
    return remoteDesktopResponse({ authorized: false }, 401);
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) {
    return remoteDesktopResponse({ authorized: false }, 415);
  }
  const body = await readBoundedJson(request, 1_024, 5_000);
  if (!body.ok) return remoteDesktopResponse({ authorized: false }, body.reason === "too_large" ? 413 : 400);
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) return remoteDesktopResponse({ authorized: false }, 400);
  const result = await authorizeRemoteDesktopSession({ sessionToken, ...parsed.data });
  if (!result.ok) return remoteDesktopResponse({ authorized: false }, result.status);
  return remoteDesktopResponse({ authorized: true, data: result.authorization }, 200);
}
