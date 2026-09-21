import "server-only";

import { clerkClient } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

// SCRIPTURE_ANCHOR: auth-known | John 10:14 | Verse: I am the good shepherd. I know my own, and I am known by my own.
/**
 * Resolve the Clerk userId from a request that's not covered by the
 * dashboard's middleware (i.e. SSE routes excluded in proxy.ts). Returns
 * null when the request has no valid session token; callers should treat
 * that as 401 Unauthorized.
 *
 * This was previously inlined verbatim in 5 routes (chat-start, responses,
 * send-stream, send-stream/cancel, approval/respond). Behaviour is identical to
 * the inline copies — same `acceptsToken: "session_token"` scope, same `userId`
 * extraction. Four of those routes have since been retired; the surviving
 * callers are approval/respond and clarify/respond.
 */
export async function getAuthenticatedUserIdFromRequest(
  request: NextRequest,
): Promise<string | null> {
  const clerk = await clerkClient();
  const requestState = await clerk.authenticateRequest(request, {
    acceptsToken: "session_token",
  });
  const authObject = requestState.toAuth();

  if (!authObject || !("userId" in authObject)) {
    return null;
  }

  return typeof authObject.userId === "string" ? authObject.userId : null;
}
