export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { z } from "zod";

import { HomeConnectorError, redeemHomeConnectorEnrolment } from "@/lib/infrastructure/home-connector";
import { log } from "@/lib/logger";
import { enrollIpLimit } from "@/lib/infrastructure/server-enrollment-http";
import { hasStrictJsonContentType, readBoundedJson } from "../../connections/request-security";

const Body = z.object({ token: z.string().max(64) }).strict();
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer" };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

// Public on purpose: the machine has no session. The one-time code, which
// works once and expires in 15 minutes, is the only credential. The reply is
// the connector's own configuration (derived secret, never the master one).
export async function POST(request: NextRequest) {
  try {
    if (request.nextUrl.search || request.headers.has("origin") || request.headers.has("sec-fetch-site")) return reply(403, { error: "forbidden" });
    const limited = enrollIpLimit(request, "home_connector_enrol", 10);
    if (limited) return limited;
    if (!hasStrictJsonContentType(request)) return reply(415, { error: "invalid_request" });
    const body = await readBoundedJson(request, 512);
    const parsed = body.ok ? Body.safeParse(body.body) : null;
    if (!parsed?.success) return reply(400, { error: "invalid_request" });
    return reply(200, await redeemHomeConnectorEnrolment(parsed.data.token));
  } catch (error) {
    if (error instanceof HomeConnectorError) return reply(error.code === "disabled" ? 404 : 400, { error: error.code });
    log.warn("Home connector enrolment unavailable", { source: "home-connector-enrol", failureType: "unavailable" });
    return reply(503, { error: "unavailable" });
  }
}
