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
  renewRemoteDesktopSessionByToken,
  SESSION_TOKEN_RE,
} from "@/lib/remote-computers/session-broker";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { remoteDesktopResponse } from "../../session-response";

const schema = z.object({
  ttlSeconds: z.number().int().min(30).max(300),
}).strict();

export async function POST(request: NextRequest) {
  // Guest-broker only. The browser's owner session and broker cookie are not
  // alternate authentication channels for rolling lease renewal.
  if (
    request.nextUrl.search || request.headers.has("origin")
    || request.headers.has("sec-fetch-site") || request.headers.has("cookie")
  ) return remoteDesktopResponse({ renewed: false }, 403);
  if (!enforceRateLimit(`remote_desktop_renew:${getIP(request)}`, { limit: 60, windowMs: 60_000 }).success) {
    return remoteDesktopResponse({ renewed: false }, 429);
  }
  const authorization = request.headers.get("authorization");
  const sessionToken = authorization?.match(/^Bearer (hrs1_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!sessionToken || !SESSION_TOKEN_RE.test(sessionToken)) {
    return remoteDesktopResponse({ renewed: false }, 401);
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) {
    return remoteDesktopResponse({ renewed: false }, 415);
  }
  const body = await readBoundedJson(request, 512, 5_000);
  if (!body.ok) return remoteDesktopResponse({ renewed: false }, body.reason === "too_large" ? 413 : 400);
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) return remoteDesktopResponse({ renewed: false }, 400);
  const result = await renewRemoteDesktopSessionByToken({
    sessionToken,
    ttlMs: parsed.data.ttlSeconds * 1_000,
  });
  if (!result.ok) return remoteDesktopResponse({ renewed: false }, result.status);
  return remoteDesktopResponse({ renewed: true, data: result.renewal }, 200);
}
