export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

import type { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { ServerEnrollmentReplaceRequestSchema } from "@/lib/infrastructure/server-enrollment-contracts";
import { replaceServerEnrollmentAccess } from "@/lib/infrastructure/server-enrollment-service";
import { noStore, ownerRequest, serverEnrollmentFailure } from "../../owner-route";

type RouteContext = { params: Promise<{ id: string }> };

/** Replace a connected server's access. Hivra signs in to that server with
 * the new key first and changes the connection only if that works. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const owner = await ownerRequest(request, { routeKey: "server_enrollment_replace", limit: 5, mutation: true });
    if ("response" in owner) return owner.response;
    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) return noStore(apiError("Setup command not found.", 404));
    const parsed = ServerEnrollmentReplaceRequestSchema.safeParse(owner.body);
    if (!parsed.success) return noStore(apiError("Invalid request.", 400));
    const connection = await replaceServerEnrollmentAccess(owner.userId, id.data, parsed.data);
    return noStore(apiSuccess({ connection }));
  } catch (error) {
    return serverEnrollmentFailure(error, "/api/infrastructure/server-enrollments/[id]/replace", "POST");
  }
}
