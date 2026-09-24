export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getServerEnrollment } from "@/lib/infrastructure/server-enrollment-service";
import { noStore, ownerRequest, serverEnrollmentFailure } from "../owner-route";

type RouteContext = { params: Promise<{ id: string }> };

/** Observed state only: downloads, refused reports and the report itself. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const owner = await ownerRequest(request, { routeKey: "server_enrollment_status", limit: 120, mutation: false });
    if ("response" in owner) return owner.response;
    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Setup command not found.", 404));
    return noStore(apiSuccess({ enrollment: await getServerEnrollment(owner.userId, id.data) }));
  } catch (error) {
    return serverEnrollmentFailure(error, "/api/infrastructure/server-enrollments/[id]", "GET");
  }
}
