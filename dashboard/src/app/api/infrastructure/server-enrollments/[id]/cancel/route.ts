export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { cancelServerEnrollment } from "@/lib/infrastructure/server-enrollment-service";
import { noStore, ownerRequest, serverEnrollmentFailure } from "../../owner-route";

type RouteContext = { params: Promise<{ id: string }> };

/** Cancel a setup command that no server has answered yet (or decline one
 * that has). The code stops working and Hivra deletes its key. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const owner = await ownerRequest(request, { routeKey: "server_enrollment_answer", limit: 20, mutation: true });
    if ("response" in owner) return owner.response;
    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Setup command not found.", 404));
    await cancelServerEnrollment(owner.userId, id.data);
    return noStore(apiSuccess({ cancelled: true }));
  } catch (error) {
    return serverEnrollmentFailure(error, "/api/infrastructure/server-enrollments/[id]/cancel", "POST");
  }
}
