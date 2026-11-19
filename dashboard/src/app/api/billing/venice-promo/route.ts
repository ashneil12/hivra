import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { RATE_LIMIT_PRESETS, enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { getStarterCreditLine, tryGrantStarterCredit } from "@/lib/billing/starter-credit";
import { isVenicePromoEnabled } from "@/lib/venice/promo/core";
import { getUserPromoLines, recordVeniceAttribution, redeemVeniceCode, tryGrantLaunchCredit, type RedeemStatus } from "@/lib/venice/promo/service";
import { VENICE_ATTRIBUTION_COOKIE, parseVeniceAttribution } from "@/lib/venice/attribution";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  code: z.string().trim().min(1).max(32),
  // Optional ?ref value from the attribution cookie, passed by the caller.
  ref: z.string().trim().max(64).optional(),
});

const MESSAGES: Record<RedeemStatus, string> = {
  saved: "Code accepted. Your credit arrives when you launch an agent with Hivra credits.",
  already_saved: "Code already accepted. Your credit arrives when you launch an agent with Hivra credits.",
  already_granted: "You already have this credit.",
  invalid_code: "That code did not work.",
  disabled: "That code did not work.",
};

/** The user's promo credit lines. Empty and cheap while the promo is off. */
export async function GET(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  // Starter credit is its own feature, not gated by the promo flag. Launch
  // asks with ?prepareLaunch=1 before it reads the balance; the grant is
  // best-effort and never throws.
  if (request.nextUrl.searchParams.get("prepareLaunch") === "1") {
    await tryGrantStarterCredit({ userId });
  }
  const starter = await getStarterCreditLine(userId).catch(() => null);
  const starterLines = starter ? [{ grantId: "starter-credit", label: starter.label, expiresAt: null }] : [];
  if (!isVenicePromoEnabled()) {
    return apiSuccess({ enabled: starterLines.length > 0, lines: starterLines, codeEntry: false });
  }
  // A visitor who arrived from /venice (or a link with ?code=) carries the
  // attribution cookie: remember it for this account. Idempotent.
  const attribution = parseVeniceAttribution(request.cookies.get(VENICE_ATTRIBUTION_COOKIE)?.value);
  if (attribution.ref || attribution.code) {
    try {
      await recordVeniceAttribution({ userId, attribution });
    } catch (error) {
      log.warn("Venice promo attribution could not be saved", {
        source: "billing/venice-promo",
        failureType: "venice_promo_attribution_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  // Launch asks with ?prepareLaunch=1 before it reads the balance, so a
  // redeemed launch credit is in the wallet in time for the credits choice.
  // tryGrantLaunchCredit checks eligibility itself and never throws.
  if (request.nextUrl.searchParams.get("prepareLaunch") === "1") {
    await tryGrantLaunchCredit({ userId });
  }
  try {
    const lines = await getUserPromoLines(userId);
    return apiSuccess({
      enabled: true,
      codeEntry: true,
      lines: [...starterLines, ...lines.map((l) => ({ grantId: l.grantId, label: l.label, expiresAt: l.expiresAt }))],
    });
  } catch {
    return apiSuccess({ enabled: starterLines.length > 0, lines: starterLines, codeEntry: false });
  }
}

/** Redeem a promo code. Saves it; the credit is granted at launch. */
export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);

  const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: "venice_promo_redeem",
    userId,
    ...RATE_LIMIT_PRESETS.settingsWrite,
  });
  if (rateLimitError) return rateLimitError;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(MESSAGES.invalid_code, 400);

  try {
    const { status } = await redeemVeniceCode({ userId, code: parsed.data.code, ref: parsed.data.ref ?? null });
    const ok = status === "saved" || status === "already_saved" || status === "already_granted";
    if (!ok) return apiError(MESSAGES[status], 400);
    return apiSuccess({ status, message: MESSAGES[status] });
  } catch (error) {
    return apiError(
      "Could not apply that code. Try again.",
      500,
      { failureType: "venice_promo_redeem_failed", errorName: error instanceof Error ? error.name : typeof error },
      undefined,
      { source: "billing/venice-promo", route: "/api/billing/venice-promo", method: "POST", userId, cause: error }
    );
  }
}
