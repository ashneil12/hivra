import { auth } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

import { hasExistingTokenHolderAccess, resolveTokenGeoBlock } from "@/lib/compliance/token-geo-gate";
import { isTokenGeoPolicyActive } from "@/lib/compliance/token-geo-policy";
import { log } from "@/lib/logger";

// Whether this visitor may see token features (lib/compliance/token-geo-policy.ts).
// Client components ask it only when the policy lists a country; with the
// dormant policy nothing calls it, and it answers "not blocked" without
// reading the request. Per-visitor, so never cached.
//
// A blocked answer also says whether the signed-in user already holds token access
// (the server's own rule, hasExistingTokenHolderAccess), so the wallet page can keep
// a holder's verify, unlock and withdraw panels and hide them from everyone else. A
// read that fails answers false: the UI then hides those panels, and the routes
// behind them still decide every action.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  let userId: string | null = null;
  if (isTokenGeoPolicyActive()) {
    try {
      userId = (await auth()).userId ?? null;
    } catch {
      userId = null;
    }
  }
  const decision = await resolveTokenGeoBlock(req, userId ? { userId } : null);
  let existingAccess = false;
  if (decision.blocked && userId) {
    try {
      existingAccess = await hasExistingTokenHolderAccess(userId);
    } catch (error) {
      log.warn("token geo: existing-access read failed; answering that the user has none", {
        source: "api/token-geo",
        userId,
        failureType: "token_geo_existing_access_read_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  const response = NextResponse.json(
    decision.blocked
      ? { blocked: true, notice: decision.message, existingAccess }
      : { blocked: false, notice: null }
  );
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
