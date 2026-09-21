// GET /api/account/composio/catalog
//
// Returns the full Composio app catalog (1,400+ toolkits) for the in-dashboard
// app picker. Server-side proxy + daily cache of Composio's public toolkits-list
// docs artifact — no user key needed (the catalog is public); connecting an app
// still uses the user's own key via the connect-link route.

import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getComposioCatalog } from "@/lib/composio/catalog";
import { isComposioConnectFlagOn } from "@/lib/composio/config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!isComposioConnectFlagOn()) return apiSuccess({ apps: [], categories: [] });

  const catalog = await getComposioCatalog();
  return apiSuccess(catalog);
}
