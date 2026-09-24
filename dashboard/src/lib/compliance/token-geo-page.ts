import { headers } from "next/headers";

import { TOKEN_GEO_NOT_BLOCKED, resolveTokenGeoBlock, type TokenGeoDecision } from "./token-geo-gate";
import { isTokenGeoPolicyActive } from "./token-geo-policy";

/**
 * The token geo decision for a server-rendered page. With the dormant (empty)
 * policy it returns "not blocked" WITHOUT calling headers() or auth(), so the
 * page renders exactly as it did before the gate existed. Once a country is
 * listed, the pages that call it read the request country when they render.
 *
 * Pass `userId` when the page already has it; otherwise the signed-in user (if
 * any) is read, so their stored country counts too. Clerk is loaded only then,
 * so public pages don't load it while the policy is dormant.
 */
export async function resolveTokenGeoBlockForPage(userId?: string | null): Promise<TokenGeoDecision> {
  if (!isTokenGeoPolicyActive()) return TOKEN_GEO_NOT_BLOCKED;
  const requestHeaders = await headers();
  let resolvedUserId = userId;
  if (resolvedUserId === undefined) {
    try {
      const { auth } = await import("@clerk/nextjs/server");
      resolvedUserId = (await auth()).userId ?? null;
    } catch {
      // Self-hosted installs run without Clerk; the IP signal still applies.
      resolvedUserId = null;
    }
  }
  return resolveTokenGeoBlock(requestHeaders, resolvedUserId ? { userId: resolvedUserId } : null);
}
