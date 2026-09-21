export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { log } from "@/lib/logger";
import { FIRST_BOOT_ENROLLMENT_BODY_LIMIT } from "@/lib/infrastructure/first-boot-enrollment";
import { FirstBootReceiverError, receiveFirstBootEnrollment } from "@/lib/infrastructure/first-boot-receiver";
import { hasStrictJsonContentType, readBoundedJson } from "../../connections/request-security";

const headers = {"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
const denied = (status:number) => NextResponse.json({accepted:false},{status,headers});

// This path is intentionally machine-authenticated, not session-authenticated.
// A browser session/cookie or a query parameter never substitutes for the
// scoped header capability. Do not add a blanket middleware/API bypass.
export async function POST(request: NextRequest) {
  try {
    if (!enforceRateLimit("first_boot_inbound:"+getIP(request),{limit:30,windowMs:60_000}).success) return denied(429);
    if (request.nextUrl.search || request.headers.has("origin") || request.headers.has("sec-fetch-site")) return denied(403);
    const authorization = request.headers.get("authorization");
    const token = authorization?.match(/^Bearer (hbe1_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) return denied(401);
    if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) return denied(415);
    const body = await readBoundedJson(request,FIRST_BOOT_ENROLLMENT_BODY_LIMIT,5_000);
    if (!body.ok) return denied(body.reason === "too_large" ? 413 : body.reason === "timeout" ? 408 : 400);
    const result = await receiveFirstBootEnrollment({token,registration:body.body});
    return NextResponse.json(result,{status:200,headers});
  } catch (error) {
    const code = error instanceof FirstBootReceiverError ? error.code : "unavailable";
    if (code === "unavailable") {
      // Allowlisted metadata only: no original exception, headers, proof,
      // guest key, request body or provider response enters logs.
      log.warn("First-boot enrollment temporarily unavailable",{source:"first-boot-enroll",failureType:code});
    }
    return denied(code === "rate_limited" ? 429 : code === "rejected" ? 401 : 503);
  }
}
