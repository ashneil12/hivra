export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { issueWorkspaceCloudHandoffCode } from "@/lib/services/workspace-cloud-handoff";

const ROUTE = "/api/workspace-cloud/handoff";

const MintSchema = z.object({
  instanceId: z.string().uuid(),
  // PKCE code_challenge — only for the browser-redirect flow. Omitted for the
  // paste-a-code pairing flow (dashboard shows the code, user pastes it).
  challenge: z.string().min(32).max(256).optional(),
});

/**
 * Mint a one-time handoff code for a lane instance the caller owns. Clerk-
 * authed: this is the step that proves the user authorized the connection.
 * The returned code is single-use and short-lived; it is exchanged for the
 * connection bundle at /api/workspace-cloud/handoff/exchange.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = getIP(request);
    const { success } = enforceRateLimit(`workspace_cloud_handoff_${ip}`, {
      limit: 20,
      windowMs: 60 * 1000,
    });
    if (!success) return apiError("Too Many Requests", 429, undefined, undefined, { route: ROUTE });

    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401, undefined, undefined, { route: ROUTE });

    const parsed = MintSchema.safeParse(await request.json());
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400, undefined, undefined, { route: ROUTE });

    const result = await issueWorkspaceCloudHandoffCode({
      userId,
      instanceId: parsed.data.instanceId,
      challenge: parsed.data.challenge,
    });
    if (!result.ok) {
      return apiError(result.error, result.status, undefined, undefined, { route: ROUTE });
    }

    return apiSuccess({ code: result.code, expiresAt: result.expiresAt });
  } catch (err) {
    return handleApiError(err);
  }
}
