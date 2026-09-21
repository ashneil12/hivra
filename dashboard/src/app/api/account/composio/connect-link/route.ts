// POST /api/account/composio/connect-link  { toolkitSlug }
//
// Initiates a hosted-OAuth connection for one Composio toolkit using the user's
// stored consumer key (via the Tool Router) and returns the login `redirectUrl`
// for the dashboard to open in a popup. Clerk-authed; the key never leaves the
// server. No SDK, no project key.

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { isComposioConnectFlagOn } from "@/lib/composio/config";
import { initiateComposioConnection } from "@/lib/composio/connect";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Composio toolkit slugs are lowercase alphanumeric + underscores (e.g. gmail,
// googlecalendar, google_sheets). Keep it tight to avoid injecting junk upstream.
const BodySchema = z.object({
  toolkitSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "Invalid app name."),
});

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!isComposioConnectFlagOn()) {
    return apiError("Composio Connect is not enabled.", 501, { failureType: "composio_disabled" });
  }

  const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: "composio_connect_link_post",
    userId,
    ...RATE_LIMIT_PRESETS.secretWrite,
  });
  if (rateLimitError) return rateLimitError;

  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return apiError("A valid app name is required.", 400);

  const result = await initiateComposioConnection(userId, parsed.data.toolkitSlug);
  if (!result.ok) {
    return apiError(result.message, 502, { failureType: "composio_connect_failed" });
  }
  return apiSuccess({ redirectUrl: result.redirectUrl });
}
