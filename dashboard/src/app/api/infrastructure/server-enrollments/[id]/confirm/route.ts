export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

import type { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { ServerEnrollmentConfirmRequestSchema } from "@/lib/infrastructure/server-enrollment-contracts";
import { confirmServerEnrollment } from "@/lib/infrastructure/server-enrollment-service";
import { noStore, ownerRequest, serverEnrollmentFailure } from "../../owner-route";

type RouteContext = { params: Promise<{ id: string }> };

/** Yes, this is my server. Creates one pinned connection for user hivra; the
 * page then runs the normal inspection. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const owner = await ownerRequest(request, { routeKey: "server_enrollment_answer", limit: 20, mutation: true });
    if ("response" in owner) return owner.response;
    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Setup command not found.", 404));
    const parsed = ServerEnrollmentConfirmRequestSchema.safeParse(owner.body);
    if (!parsed.success) return noStore(apiError("Invalid answer.", 400));
    const connection = await confirmServerEnrollment(owner.userId, id.data, parsed.data);
    return noStore(apiSuccess({ connection }, 201));
  } catch (error) {
    return serverEnrollmentFailure(error, "/api/infrastructure/server-enrollments/[id]/confirm", "POST");
  }
}
