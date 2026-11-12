export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { z } from "zod";

import { hasStrictJsonContentType, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { enrollIpLimit } from "@/lib/infrastructure/server-enrollment-http";
import { isLocalBridgeEnabled } from "@/lib/local-bridge/flag";
import { redeemEnrolCode } from "@/lib/local-bridge/service";
import { log } from "@/lib/logger";

const Body = z.object({ token: z.string().max(64) }).strict();
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer" };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

// Public on purpose: the computer has no session. The one-time code, which works
// once and expires in 15 minutes, is the only credential. The reply is the
// bridge's own configuration, returned once and never logged.
export async function POST(request: NextRequest) {
  try {
    if (!isLocalBridgeEnabled()) return reply(404, { error: "not_found" });
    if (request.nextUrl.search || request.headers.has("origin") || request.headers.has("sec-fetch-site")) return reply(403, { error: "forbidden" });
    const limited = enrollIpLimit(request, "local_bridge_enrol", 10);
    if (limited) return limited;
    if (!hasStrictJsonContentType(request)) return reply(415, { error: "invalid_request" });
    const body = await readBoundedJson(request, 512);
    const parsed = body.ok ? Body.safeParse(body.body) : null;
    if (!parsed?.success) return reply(400, { error: "invalid_request" });
    const redeemed = await redeemEnrolCode(parsed.data.token);
    if (!redeemed.ok) return reply(400, { error: "not_usable" });
    return reply(200, redeemed.value);
  } catch {
    log.warn("Local bridge enrolment unavailable", { source: "local-bridge-enrol", failureType: "unavailable" });
    return reply(503, { error: "unavailable" });
  }
}
