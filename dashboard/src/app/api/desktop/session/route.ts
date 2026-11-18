export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, handleApiError } from "@/lib/api-response";
import {
  TICKET_TTL_SECONDS,
  desktopBrowserSignInEnabled,
  handoffSecret,
  redeemHandoffCode,
} from "@/lib/desktop/browser-sign-in";
import { log } from "@/lib/logger";

const LOG_SOURCE = "desktop-browser-sign-in";

const BodySchema = z.object({
  code: z.string().min(1).max(1024),
  verifier: z.string().min(43).max(128),
});

/**
 * POST /api/desktop/session: the desktop app trades the code the browser
 * handed it (plus the verifier only the app knows) for a single-use Clerk
 * sign-in ticket. No session cookie is involved. See
 * lib/desktop/browser-sign-in.ts.
 */
export async function POST(request: NextRequest) {
  try {
    if (!desktopBrowserSignInEnabled()) return apiError("Not found", 404);
    const secret = handoffSecret();
    if (!secret) return apiError("Sign-in is not configured", 503);

    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError("Invalid request", 400);

    const redeemed = redeemHandoffCode({ ...parsed.data, secret });
    if (!redeemed.ok) {
      log.warn("desktop sign-in code refused", { source: LOG_SOURCE, failureType: redeemed.reason });
      return apiError("This sign-in has expired. Please sign in again.", 400);
    }

    const client = await clerkClient();
    const token = await client.signInTokens.createSignInToken({
      userId: redeemed.userId,
      expiresInSeconds: TICKET_TTL_SECONDS,
    });
    log.info("desktop sign-in ticket issued", { source: LOG_SOURCE, userId: redeemed.userId });
    return Response.json(
      { success: true, data: { ticket: token.token } },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
