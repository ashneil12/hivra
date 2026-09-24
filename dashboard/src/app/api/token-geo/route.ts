import { auth } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

import { resolveTokenGeoBlock } from "@/lib/compliance/token-geo-gate";
import { isTokenGeoPolicyActive } from "@/lib/compliance/token-geo-policy";

// Whether this visitor may see token features (lib/compliance/token-geo-policy.ts).
// Client components ask it only when the policy lists a country; with the
// dormant policy nothing calls it, and it answers "not blocked" without
// reading the request. Per-visitor, so never cached.
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
  const response = NextResponse.json({
    blocked: decision.blocked,
    notice: decision.blocked ? decision.message : null,
  });
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
