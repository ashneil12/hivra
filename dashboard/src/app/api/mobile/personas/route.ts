export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { auth } from "@clerk/nextjs/server";

import { apiError, handleApiError } from "@/lib/api-response";
import { buildMobilePersonaCatalog } from "@/lib/mobile/persona-catalog";

/**
 * GET /api/mobile/personas — the quiz-onboarding persona catalog (iOS Phase 2).
 *
 * Serves WELCOME_PERSONAS through the consumer projection in
 * lib/mobile/persona-catalog.ts so personas can be re-pitched/re-ordered
 * without an app release. Engine jargon (agent-type keys, soul ids,
 * personality prompt clauses) never leaves the server.
 *
 * Clerk-authed. The payload is identical for every user, so a short shared
 * cache is safe and soaks up the app's quiz-screen fetches:
 * s-maxage lets Vercel's edge serve repeats for 5 minutes, SWR keeps it warm.
 */
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const response = Response.json(
      { success: true, data: { personas: buildMobilePersonaCatalog() } },
      { status: 200 }
    );
    response.headers.set(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=600"
    );
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
