// Read-only canonical relationships. This does not switch inventory authority,
// acquire a guest lease, install software or activate an agent binding.
export const runtime = "nodejs";
export const maxDuration = 15;
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { createCanonicalRelationshipReader } from "@/lib/agent-computers/relationship-reader";

const noStore = <T extends Response>(response: T): T => {
  response.headers.set("Cache-Control", "no-store"); return response;
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return noStore(apiError("Not found", 404));
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const limited = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "hivra:computer-relationships:read", userId, limit: 60, windowMs: 60_000,
    });
    if (limited) return noStore(limited);
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) return noStore(apiError("Invalid canonical computer ID.", 400));
    const relationships = await createCanonicalRelationshipReader().read(userId, id);
    if (!relationships) return noStore(apiError("Computer not found.", 404));
    return noStore(apiSuccess(relationships));
  } catch {
    return noStore(apiError("Computer relationships are unavailable. No relationship state was changed.", 503,
      undefined, undefined, { route: "/api/hivra/computers/[id]/relationships", method: "GET",
        failureType: "canonical_relationship_read_unavailable" }));
  }
}
