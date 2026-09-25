export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

import type { NextRequest } from "next/server";

import { log } from "@/lib/logger";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { retryAfterSeconds } from "@/lib/authenticated-rate-limit";
import { SERVER_ENROLLMENT_REPORT_BODY_LIMIT, serverEnrollmentCodeFromAuthorization } from "@/lib/infrastructure/server-enrollment-code";
import { enrollTextResponse } from "@/lib/infrastructure/server-enrollment-http";
import { receiveServerEnrollmentReport, reportResponseBody } from "@/lib/infrastructure/server-enrollment-receiver";
import { trustedClientAddress } from "@/lib/infrastructure/trusted-client-address";
import { hasStrictJsonContentType, readBoundedText } from "../../connections/request-security";

const deny = (status: number, reportStatus: string, extra: Record<string, string> = {}) =>
  enrollTextResponse(status, reportResponseBody(reportStatus), extra);

// Machine-authenticated by the one-time code in the Authorization header,
// never by a Clerk session, a cookie or a query parameter. The middleware
// excludes exactly this path.
export async function POST(request: NextRequest) {
  try {
    if (request.nextUrl.search || request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
      return deny(403, "forbidden");
    }
    // Checked against its pattern before any database read.
    const code = serverEnrollmentCodeFromAuthorization(request.headers.get("authorization"));
    if (!code) return deny(401, "not_usable");
    const limit = enforceRateLimit("server_enrollment_report:" + getIP(request), { limit: 30, windowMs: 60_000 });
    if (!limit.success) return deny(429, "retry", { "Retry-After": String(retryAfterSeconds(limit.retryAfterMs)) });
    if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) return deny(415, "invalid_report");
    const body = await readBoundedText(request, SERVER_ENROLLMENT_REPORT_BODY_LIMIT, 5_000);
    if (!body.ok) {
      return deny(body.reason === "too_large" ? 413 : body.reason === "timeout" ? 408 : 400, "invalid_report");
    }
    const outcome = await receiveServerEnrollmentReport({
      code, rawBody: body.text, observed: trustedClientAddress(request),
    });
    if (outcome.log.failureClass) {
      // Allowlisted fields only: never the code, headers, body, keys or address.
      log.info("Server enrollment report refused or replayed", {
        source: "server-enrollment-report",
        failureClass: outcome.log.failureClass,
        scriptVersion: outcome.log.scriptVersion,
        addressClass: outcome.log.addressClass,
      });
    }
    return enrollTextResponse(outcome.httpStatus, outcome.body,
      outcome.httpStatus === 429 ? { "Retry-After": "60" } : {});
  } catch {
    log.warn("Server enrollment report temporarily unavailable", {
      source: "server-enrollment-report", failureClass: "unavailable",
    });
    return deny(503, "unavailable");
  }
}
