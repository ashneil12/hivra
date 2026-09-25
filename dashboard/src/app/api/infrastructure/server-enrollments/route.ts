export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

import type { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { ServerEnrollmentIssueRequestSchema } from "@/lib/infrastructure/server-enrollment-contracts";
import { isServerEnrollmentReportReachable } from "@/lib/infrastructure/server-enrollment-readiness";
import { issueServerEnrollment, listServerEnrollments } from "@/lib/infrastructure/server-enrollment-service";
import { noStore, ownerRequest, serverEnrollmentFailure } from "./owner-route";

const ROUTE = "/api/infrastructure/server-enrollments";

/** The owner's open setup commands, answers still to give, recent results
 * and connection receipts. Never a code. */
export async function GET(request: NextRequest) {
  try {
    const owner = await ownerRequest(request, { routeKey: "server_enrollment_status", limit: 120, mutation: false });
    if ("response" in owner) return owner.response;
    return noStore(apiSuccess(await listServerEnrollments(owner.userId)));
  } catch (error) {
    return serverEnrollmentFailure(error, ROUTE, "GET");
  }
}

/** Issue a setup command. The response carries the one-time code inside the
 * command, once; the page holds it in memory only. */
export async function POST(request: NextRequest) {
  try {
    const owner = await ownerRequest(request, { routeKey: "server_enrollment_issue", limit: 10, mutation: true });
    if ("response" in owner) return owner.response;
    const parsed = ServerEnrollmentIssueRequestSchema.safeParse(owner.body);
    if (!parsed.success) return noStore(apiError("Invalid setup command request.", 400));
    const issued = await issueServerEnrollment(owner.userId, parsed.data, { reachable: isServerEnrollmentReportReachable });
    return noStore(apiSuccess(issued, 201));
  } catch (error) {
    return serverEnrollmentFailure(error, ROUTE, "POST");
  }
}
