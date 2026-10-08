export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { declineServerEnrollment } from "@/lib/infrastructure/server-enrollment-service";
import { noStore, ownerRequest, serverEnrollmentFailure } from "../../owner-route";

type RouteContext = { params: Promise<{ id: string }> };

/** No, cancel. Hivra deletes its key for that server. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const owner = await ownerRequest(request, { routeKey: "server_enrollment_answer", limit: 20, mutation: true });
    if ("response" in owner) return owner.response;
    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Setup command not found.", 404));
    await declineServerEnrollment(owner.userId, id.data);
    return noStore(apiSuccess({ declined: true }));
  } catch (error) {
    return serverEnrollmentFailure(error, "/api/infrastructure/server-enrollments/[id]/decline", "POST");
  }
}
