export const runtime = "nodejs";

import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { powerWorkspaceCloudAgent } from "@/lib/services/workspace-cloud-provisioner";

const ROUTE = "/api/workspace-cloud/instances/[id]/power";
const PowerSchema = z.object({ action: z.enum(["start", "stop", "reboot"]) });

/** Basic VM power ops for the simple dashboard (pause/restart). Owner-scoped. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401, undefined, undefined, { route: ROUTE });
    const { id } = await params;
    const parsed = PowerSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400, undefined, undefined, { route: ROUTE });
    const result = await powerWorkspaceCloudAgent({ instanceId: id, userId, action: parsed.data.action });
    if (!result.ok) return apiError(result.error, result.status, undefined, undefined, { route: ROUTE });
    return apiSuccess({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
