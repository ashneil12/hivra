// The order the Launch catalog lists agents in: agent types by how many
// people used each in the last 30 days. The order only, never the numbers.
// Off with the Launch catalog switch.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { readCatalogOrder } from "@/lib/hivra/catalog-claims";
import { isLaunchCatalogEnabled } from "@/lib/launch/launch-catalog";

// GET /api/hivra/catalog/order
export async function GET() {
  try {
    if (!isLaunchCatalogEnabled()) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    return apiSuccess({ order: await readCatalogOrder() });
  } catch (err) {
    return handleApiError(err);
  }
}
