// /api/account/composio/connected-apps
//
// GET  → the surfaced toolkit slugs the user has an ACTIVE Composio connection
//        for (the sidebar's "connected apps" row / quick-connect tiles).
// POST → the ACTIVE subset of an explicit slug batch ({ slugs: [...] }) — used by
//        the app picker to badge the currently-visible page (which spans the full
//        catalog, beyond the surfaced set).
// Clerk-authed; uses the user's own consumer key via the Tool Router.

import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { isComposioConnectFlagOn } from "@/lib/composio/config";
import { listComposioConnectedApps } from "@/lib/composio/connect";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Batch cap — Composio's action:list is happiest with a few dozen slugs per call.
const MAX_BATCH = 50;

export async function GET() {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!isComposioConnectFlagOn()) return apiSuccess({ apps: [] });

  const apps = await listComposioConnectedApps(userId);
  return apiSuccess({ apps: apps ?? [] });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!isComposioConnectFlagOn()) return apiSuccess({ apps: [] });

  const body = (await req.json().catch(() => null)) as { slugs?: unknown } | null;
  const slugs = Array.isArray(body?.slugs)
    ? body.slugs.filter((s: unknown): s is string => typeof s === "string").slice(0, MAX_BATCH)
    : undefined;

  const apps = await listComposioConnectedApps(userId, slugs);
  return apiSuccess({ apps: apps ?? [] });
}
